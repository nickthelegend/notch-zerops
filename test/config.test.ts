/**
 * Config drift, and the two ways it can cry wolf.
 *
 * The failure this catches is quiet — the deploy succeeds and the app dies on the first
 * request that reads the variable — so the check has to be trusted. A checker that reports
 * `DATABASE_URL` as missing on every project with a database gets muted within a day, and a
 * muted checker is worse than none.
 */
import { describe, expect, it } from 'vitest';

import { compareConfig, describeConfig } from '../src/zerops/config.js';

describe('compareConfig', () => {
  it('reports a variable the repo reads and the project does not define', () => {
    const d = compareConfig(['JWT_SECRET'], [], []);
    expect(d.missing).toEqual(['JWT_SECRET']);
  });

  it('does not report one that is defined', () => {
    const d = compareConfig(['JWT_SECRET'], ['JWT_SECRET'], []);
    expect(d.missing).toEqual([]);
    expect(d.present).toEqual(['JWT_SECRET']);
  });

  it('matches case-insensitively, because platforms disagree about case', () => {
    expect(compareConfig(['Jwt_Secret'], ['JWT_SECRET'], []).missing).toEqual([]);
  });

  it('treats a connection string as PROVIDED once the service exists', () => {
    // The single most common variable there is. Reporting it as missing on every project that
    // has a database would train everyone to ignore this check.
    const d = compareConfig(['DATABASE_URL'], [], ['postgresql']);
    expect(d.missing).toEqual([]);
    expect(d.provided).toEqual([{ key: 'DATABASE_URL', by: 'postgresql' }]);
  });

  it('still reports a connection string when the service is NOT there', () => {
    const d = compareConfig(['DATABASE_URL'], [], ['valkey']);
    expect(d.missing).toEqual(['DATABASE_URL']);
  });

  it('maps each family to the service that answers it', () => {
    expect(compareConfig(['REDIS_URL'], [], ['valkey']).provided[0]?.by).toBe('valkey');
    expect(compareConfig(['QDRANT_URL'], [], ['qdrant']).provided[0]?.by).toBe('qdrant');
    expect(compareConfig(['S3_ENDPOINT_URL'], [], ['objectstorage']).provided[0]?.by).toBe('objectstorage');
  });

  it('ignores the keys Zerops sets on every project', () => {
    const d = compareConfig(['storageCdnUrl', 'zeropsSubdomainHost'], [], []);
    expect(d.missing).toEqual([]);
  });

  it('deduplicates and sorts, so the report is stable between runs', () => {
    const d = compareConfig(['B_SECRET', 'A_SECRET', 'B_SECRET'], [], []);
    expect(d.missing).toEqual(['A_SECRET', 'B_SECRET']);
  });

  it('names the consequence, not just the count', () => {
    // "1 variable missing" is not actionable. What happens next is.
    const line = describeConfig(compareConfig(['JWT_SECRET'], [], []));
    expect(line).toContain('JWT_SECRET');
    expect(line).toContain('fail at runtime');
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeConfig(compareConfig([], [], []))).toBe('');
  });
});
