import type { GatewayIdentity } from '@dash/mobile-contract';
import { CHAT_INPUT_QUEUE_CAPABILITY, type MobileV2HealthResponse } from '@dash/mobile-contract-v2';
import { MobileApiError, type MobileRestClient } from './rest.js';

export type NegotiatedMobileProtocol =
  | { version: 1; capabilities: string[]; rest: MobileRestClient }
  | { version: 2; capabilities: string[]; rest: MobileRestClient };

export interface MobileProtocolOptions {
  createRestClient(version: 1 | 2): MobileRestClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isRfc3339(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    !(
      year > 0 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth(year, month) &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 60 &&
      offsetHour <= 23 &&
      offsetMinute <= 59
    )
  ) {
    return false;
  }
  if (second < 60) return true;

  const offsetSign = match[7] === '-' ? -1 : 1;
  const utcMinute = minute - offsetMinute * offsetSign;
  const utcHour = hour - offsetHour * offsetSign - (utcMinute < 0 ? 1 : 0);
  return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isMobileV2HealthResponse(value: unknown): value is MobileV2HealthResponse {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      'status',
      'startedAt',
      'pid',
      'agents',
      'channels',
      'apiVersion',
      'capabilities',
    ])
  ) {
    return false;
  }
  return (
    value.status === 'healthy' &&
    isRfc3339(value.startedAt) &&
    isPositiveSafeInteger(value.pid) &&
    isNonnegativeSafeInteger(value.agents) &&
    isNonnegativeSafeInteger(value.channels) &&
    value.apiVersion === 2 &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((item) => typeof item === 'string' && item.length > 0) &&
    new Set(value.capabilities).size === value.capabilities.length &&
    value.capabilities.includes(CHAT_INPUT_QUEUE_CAPABILITY)
  );
}

function isGatewayIdentity(value: unknown): value is GatewayIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['gatewayId', 'publicKey']) &&
    typeof value.gatewayId === 'string' &&
    value.gatewayId.length > 0 &&
    typeof value.publicKey === 'string' &&
    value.publicKey.length > 0
  );
}

function isUnsupportedV2(error: unknown): boolean {
  return (
    error instanceof MobileApiError &&
    (error.status === 404 ||
      (error.status === 426 && error.apiError?.code === 'capability_required'))
  );
}

export async function negotiateMobileProtocol(
  options: MobileProtocolOptions,
): Promise<NegotiatedMobileProtocol> {
  const v2 = options.createRestClient(2);
  let health: MobileV2HealthResponse;
  try {
    health = await v2.healthV2();
  } catch (error) {
    if (!isUnsupportedV2(error)) throw error;
    const v1 = options.createRestClient(1);
    await v1.health();
    await v1.identity();
    return { version: 1, capabilities: [], rest: v1 };
  }
  if (!isMobileV2HealthResponse(health)) {
    throw new Error('Malformed mobile v2 health');
  }
  const identity = await v2.identity();
  if (!isGatewayIdentity(identity)) {
    throw new Error('Malformed gateway identity');
  }
  return { version: 2, capabilities: health.capabilities, rest: v2 };
}
