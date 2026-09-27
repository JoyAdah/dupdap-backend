import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StellarTxQueueService } from './stellar-tx-queue.service';
import * as StellarSdk from '@stellar/stellar-sdk';

jest.mock('@stellar/stellar-sdk', () => {
  const mockKeypair = {
    publicKey: jest.fn().mockReturnValue('GTESTPUBLICKEY'),
    secret: jest.fn().mockReturnValue('STESTSECRET'),
  };

  const mockAccount = {
    sequence: '123456',
    accountId: 'GTESTPUBLICKEY',
  };

  const mockTransaction = {
    sign: jest.fn(),
  };

  const mockTransactionBuilder = {
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue(mockTransaction),
  };

  const mockServer = {
    loadAccount: jest.fn().mockResolvedValue(mockAccount),
    submitTransaction: jest.fn().mockResolvedValue({ hash: 'tx-hash-123' }),
  };

  return {
    Keypair: {
      fromSecret: jest.fn().mockReturnValue(mockKeypair),
    },
    TransactionBuilder: jest.fn().mockImplementation(() => mockTransactionBuilder),
    Operation: {
      manageData: jest.fn().mockReturnValue({ type: 'manageData' }),
      payment: jest.fn().mockReturnValue({ type: 'payment' }),
    },
    Memo: {
      text: jest.fn().mockReturnValue({ type: 'text' }),
    },
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; September 2015',
    },
    BASE_FEE: '100',
    Horizon: {
      Server: jest.fn().mockImplementation(() => mockServer),
    },
  };
});

describe('StellarTxQueueService', () => {
  let service: StellarTxQueueService;
  let configService: jest.Mocked<ConfigService>;
  let mockServer: any;

  beforeEach(async () => {
    const mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        const values: Record<string, string> = {
          STELLAR_NETWORK: 'TESTNET',
          STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
          STELLAR_ACCOUNT_SECRET: 'STESTSECRET',
          STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        };
        return values[key];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarTxQueueService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get(StellarTxQueueService);
    configService = module.get(ConfigService);

    // Get the mocked server instance
    const StellarSdk = await import('@stellar/stellar-sdk');
    mockServer = new StellarSdk.Horizon.Server();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('onModuleInit', () => {
    it('initializes server, network passphrase, and keypair', () => {
      expect(configService.get).toHaveBeenCalledWith('STELLAR_NETWORK', 'TESTNET');
      expect(configService.get).toHaveBeenCalledWith('STELLAR_HORIZON_URL');
      expect(configService.get).toHaveBeenCalledWith('STELLAR_ACCOUNT_SECRET');
    });
  });

  describe('submitManageData', () => {
    it('submits a manageData operation and returns transaction hash', async () => {
      const hash = await service.submitManageData('group:user1', 'Test Group');

      expect(hash).toBe('tx-hash-123');
      expect(mockServer.loadAccount).toHaveBeenCalledWith('GTESTPUBLICKEY');
      expect(mockServer.submitTransaction).toHaveBeenCalled();
    });

    it('serializes concurrent submissions', async () => {
      // Submit multiple concurrent requests
      const promises = [
        service.submitManageData('group:user1', 'Group 1'),
        service.submitManageData('group:user2', 'Group 2'),
        service.submitManageData('group:user3', 'Group 3'),
      ];

      const results = await Promise.all(promises);

      // All should succeed
      expect(results).toHaveLength(3);
      results.forEach((hash) => expect(hash).toBe('tx-hash-123'));

      // loadAccount should be called 3 times (once per serialized submission)
      expect(mockServer.loadAccount).toHaveBeenCalledTimes(3);
    });

    it('retries on tx_bad_seq error', async () => {
      const badSeqError = {
        response: {
          data: {
            error: 'tx_bad_seq',
          },
        },
      };

      mockServer.submitTransaction
        .mockRejectedValueOnce(badSeqError)
        .mockResolvedValueOnce({ hash: 'tx-hash-retry' });

      const hash = await service.submitManageData('group:user1', 'Test Group');

      expect(hash).toBe('tx-hash-retry');
      expect(mockServer.loadAccount).toHaveBeenCalledTimes(2); // Initial + retry
      expect(mockServer.submitTransaction).toHaveBeenCalledTimes(2);
    });

    it('throws if STELLAR_ACCOUNT_SECRET not configured', async () => {
      // Create a new service instance without secret
      const mockConfig = {
        get: jest.fn().mockImplementation((key: string) => {
          const values: Record<string, string> = {
            STELLAR_NETWORK: 'TESTNET',
            STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
            // STELLAR_ACCOUNT_SECRET not set
          };
          return values[key];
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StellarTxQueueService,
          { provide: ConfigService, useValue: mockConfig },
        ],
      }).compile();

      const serviceWithoutSecret = module.get(StellarTxQueueService);
      await serviceWithoutSecret.onModuleInit();

      await expect(
        serviceWithoutSecret.submitManageData('group:user1', 'Test Group'),
      ).rejects.toThrow('STELLAR_ACCOUNT_SECRET not configured');
    });
  });

  describe('submitPayment', () => {
    it('submits a payment operation and returns transaction hash', async () => {
      const mockAsset = { code: 'USDC', issuer: 'GUSDC' };
      const hash = await service.submitPayment(
        'GDESTINATION',
        '100.00',
        mockAsset as any,
        'test memo',
      );

      expect(hash).toBe('tx-hash-123');
      expect(mockServer.loadAccount).toHaveBeenCalledWith('GTESTPUBLICKEY');
      expect(mockServer.submitTransaction).toHaveBeenCalled();
    });
  });
});