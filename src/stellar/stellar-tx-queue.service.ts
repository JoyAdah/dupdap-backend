import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';

/**
 * Serializes transaction submissions from the shared Stellar treasury account
 * to prevent sequence number conflicts (tx_bad_seq) under concurrent load.
 *
 * This service maintains an in-process promise queue keyed by the source account
 * public key. Each submitted transaction waits for the previous one on the same
 * account to complete before loading the account, building, signing, and submitting.
 *
 * If Horizon returns a tx_bad_seq error (sequence number mismatch), the service
 * reloads the account and retries once.
 */
@Injectable()
export class StellarTxQueueService implements OnModuleInit {
  private readonly logger = new Logger(StellarTxQueueService.name);
  private server: StellarSdk.Horizon.Server;
  private networkPassphrase: string;
  private keypair: StellarSdk.Keypair;

  // Per-account submission queue: maps account publicKey to the last submission promise
  private readonly submissionQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const network = this.config.get('STELLAR_NETWORK', 'TESTNET');
    const horizonUrl = this.config.get(
      'STELLAR_HORIZON_URL',
      network === 'PUBLIC'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org',
    );

    this.server = new StellarSdk.Horizon.Server(horizonUrl);
    this.networkPassphrase =
      network === 'PUBLIC'
        ? StellarSdk.Networks.PUBLIC
        : StellarSdk.Networks.TESTNET;

    const secret = this.config.get('STELLAR_ACCOUNT_SECRET');
    if (secret) {
      this.keypair = StellarSdk.Keypair.fromSecret(secret);
    }
  }

  /**
   * Submits a transaction from the shared treasury account, serializing
   * against other submissions from the same account.
   *
   * @param buildTx - Callback that receives the loaded Stellar account and
   *   returns a built (but unsigned) Transaction.
   * @returns The transaction hash from Horizon.
   */
  async submitFromTreasury<T extends StellarSdk.Transaction>(
    buildTx: (account: StellarSdk.Horizon.ServerApi.AccountRecord) => T,
  ): Promise<string> {
    if (!this.keypair) {
      throw new Error('STELLAR_ACCOUNT_SECRET not configured');
    }

    const publicKey = this.keypair.publicKey();
    const queueKey = publicKey;

    // Chain onto the previous submission for this account.
    // Use a wrapper that always resolves so failed submissions don't block the queue.
    const previous = this.submissionQueues.get(queueKey) ?? Promise.resolve();

    const submissionPromise = previous
      .catch(() => {
        // Ignore previous failure; we still want to proceed with this submission
      })
      .then(async () => {
        // Load the latest account state (sequence number) right before submission
        const account = await this.server.loadAccount(publicKey);

        const tx = buildTx(account);
        tx.sign(this.keypair);

        try {
          const result = await this.server.submitTransaction(tx);
          return (result as any).hash as string;
        } catch (err: any) {
          // If sequence number is stale (tx_bad_seq), reload account and retry once
          if (this.isBadSeqError(err)) {
            this.logger.warn(
              `Sequence number conflict for ${publicKey}, reloading account and retrying`,
            );
            const freshAccount = await this.server.loadAccount(publicKey);
            const retryTx = buildTx(freshAccount);
            retryTx.sign(this.keypair);
            const result = await this.server.submitTransaction(retryTx);
            return (result as any).hash as string;
          }
          throw err;
        }
      });

    // Update the queue with the new submission promise.
    // We store a version that never rejects (to avoid unhandled rejection warnings
    // and to ensure the next submission can chain correctly).
    this.submissionQueues.set(
      queueKey,
      submissionPromise.catch((e) => {
        throw e;
      }),
    );

    return submissionPromise as Promise<string>;
  }

  /**
   * Submits a manageData operation from the treasury account.
   * Convenience wrapper for the common use case in GroupsService.
   */
  async submitManageData(name: string, value: string): Promise<string> {
    return this.submitFromTreasury((account) => {
      return new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name,
            value,
          }),
        )
        .setTimeout(30)
        .build();
    });
  }

  /**
   * Submits a payment operation from the treasury account.
   * Convenience wrapper for the common use case in StellarService.sendPayment.
   */
  async submitPayment(
    destinationId: string,
    amount: string,
    asset: StellarSdk.Asset,
    memo?: string,
  ): Promise<string> {
    return this.submitFromTreasury((account) => {
      const txBuilder = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: destinationId,
            asset,
            amount,
          }),
        )
        .setTimeout(30);

      if (memo) {
        txBuilder.addMemo(StellarSdk.Memo.text(memo));
      }

      return txBuilder.build();
    });
  }

  private isBadSeqError(err: any): boolean {
    if (!err?.response?.data) return false;
    const data = err.response.data;
    // Horizon returns { error: 'tx_bad_seq', ... } or includes it in extras
    return (
      data.error === 'tx_bad_seq' ||
      data.extras?.result_codes?.transaction === 'tx_bad_seq' ||
      data.extras?.result_codes?.operations?.includes('op_bad_seq')
    );
  }
}