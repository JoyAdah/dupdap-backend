import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

function isIpv6(addr: string): boolean {
  return addr.includes(':');
}

/**
 * Expand an IPv6 address into its 16-byte representation.
 *
 * Handles `::` compression and a trailing dotted-quad (IPv4-mapped) form.
 * Returns `null` when the address cannot be parsed, so callers can fail closed
 * instead of silently coercing to zero.
 */
function ipv6ToBytes(addr: string): number[] | null {
  let input = addr.trim();
  if (input.startsWith('[') && input.endsWith(']')) input = input.slice(1, -1);

  // Strip a zone index (e.g. `fe80::1%eth0`).
  const zone = input.indexOf('%');
  if (zone !== -1) input = input.slice(0, zone);

  if (input === '') return null;

  // A trailing dotted-quad (IPv4-mapped/compatible) contributes two groups.
  let tailGroups: number[] = [];
  const lastColon = input.lastIndexOf(':');
  const tail = input.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.');
    if (octets.length !== 4) return null;
    const nums = octets.map((o) => (/^\d{1,3}$/.test(o) ? parseInt(o, 10) : NaN));
    if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    tailGroups = [(nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]];
    input = input.slice(0, lastColon + 1);
  }

  const doubleColon = input.indexOf('::');
  let head: string[];
  let tailParts: string[];
  if (doubleColon !== -1) {
    if (input.indexOf('::', doubleColon + 1) !== -1) return null;
    head = input.slice(0, doubleColon).split(':').filter(Boolean);
    tailParts = input.slice(doubleColon + 2).split(':').filter(Boolean);
  } else {
    head = input.split(':').filter(Boolean);
    tailParts = [];
  }

  const parseGroups = (parts: string[]): number[] | null => {
    const groups: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };

  const headGroups = parseGroups(head);
  const tailGroupNums = parseGroups(tailParts);
  if (headGroups === null || tailGroupNums === null) return null;

  const explicit = [...headGroups, ...tailGroupNums, ...tailGroups];
  if (doubleColon === -1) {
    if (explicit.length !== 8) return null;
  } else if (explicit.length > 7) {
    return null;
  }

  const missing = 8 - explicit.length;
  const groups =
    doubleColon === -1
      ? explicit
      : [...headGroups, ...Array(missing).fill(0), ...tailGroupNums, ...tailGroups];

  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

function ipv6InCidr(ip: string, range: string, bits: number): boolean {
  if (bits < 0 || bits > 128) return false;
  const ipBytes = ipv6ToBytes(ip);
  const rangeBytes = ipv6ToBytes(range);
  if (!ipBytes || !rangeBytes) return false;

  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== rangeBytes[i]) return false;
  }
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (ipBytes[fullBytes] & mask) === (rangeBytes[fullBytes] & mask);
}

function ipInCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;

  const [range, bitsRaw] = cidr.split('/');
  const bits = parseInt(bitsRaw, 10);
  if (Number.isNaN(bits)) return false;

  // IPv6 addresses cannot be parsed as 32-bit dotted-quads; match them with a
  // dedicated 128-bit comparison instead of silently coercing to 0.
  if (isIpv6(ip) || isIpv6(range)) {
    return ipv6InCidr(ip, range, bits);
  }

  if (bits < 0 || bits > 32) return false;
  const mask = ~((1 << (32 - bits)) - 1) >>> 0;

  const toInt = (addr: string) => {
    const octets = addr.split('.');
    if (octets.length !== 4) return NaN;
    return octets.reduce((acc, octet) => {
      if (!/^\d{1,3}$/.test(octet)) return NaN;
      const value = parseInt(octet, 10);
      if (value < 0 || value > 255) return NaN;
      return (acc << 8) + value;
    }, 0) >>> 0;
  };

  const ipInt = toInt(ip);
  const rangeInt = toInt(range);
  if (Number.isNaN(ipInt) || Number.isNaN(rangeInt)) return false;

  return (ipInt & mask) === (rangeInt & mask);
}

/**
 * Resolve the client IP for allowlist checks.
 *
 * We deliberately do NOT parse `X-Forwarded-For` by hand: that header is
 * attacker-controlled unless a trusted reverse proxy overwrites it. Instead we
 * rely on Express's `req.ip`, which honours the app's `trust proxy` setting
 * (configured in `main.ts` from the `TRUST_PROXY` env var). When no trusted
 * proxy is configured, `req.ip` is the raw socket address and cannot be
 * spoofed; when one is, Express derives the left-most untrusted address for us.
 * `req.socket.remoteAddress` is the last-resort fallback.
 */
function getClientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? '';
}

@Injectable()
export class IpAllowlistGuard implements CanActivate {
  private readonly logger = new Logger(IpAllowlistGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const isDev = this.config.get<string>('NODE_ENV') === 'development';
    const bypassInDev = this.config.get<string>('ADMIN_IP_BYPASS_IN_DEV') === 'true';

    if (isDev && bypassInDev) return true;

    const raw = this.config.get<string>('ADMIN_ALLOWED_IPS', '');
    const allowedEntries = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const req = context.switchToHttp().getRequest<Request>();
    const clientIp = getClientIp(req);

    if (allowedEntries.length === 0 || !allowedEntries.some((entry) => ipInCidr(clientIp, entry))) {
      this.logger.warn(
        `[Security] Blocked admin access from IP=${clientIp} ${req.method} ${req.originalUrl}`,
      );
      throw new ForbiddenException('Access denied: IP not in allowlist');
    }

    return true;
  }
}
