import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key used by the global response-wrapping interceptor to detect
 * handlers whose return value must be sent as-is (e.g. the raw Prometheus
 * text-exposition-format payload from `GET /metrics`).
 */
export const SKIP_RESPONSE_WRAP_KEY = 'skipResponseWrap';

/**
 * Marks a route handler so that its response is not wrapped in the standard
 * JSON envelope. Used by the Prometheus metrics controller to return the raw
 * text-exposition-format output consumed by Grafana dashboards.
 */
export const SkipResponseWrap = (): MethodDecorator =>
  SetMetadata(SKIP_RESPONSE_WRAP_KEY, true);
