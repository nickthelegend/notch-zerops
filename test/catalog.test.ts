/**
 * Version resolution and hostname safety.
 *
 * Both of these fail at provision time if they are wrong — in front of whoever is watching —
 * and both fail with platform errors that name the symptom rather than the cause. `valkey@7`
 * comes back as "Service base not found" without telling you the answer is `7.2`; a bad
 * hostname comes back as a generic validation error.
 *
 * The version strings in these fixtures are copied from a live `/service-stack-type/search`
 * response, including the shapes that broke a naive parser: a two-part version (`7.2`), a
 * runtime with an OS prefix (`alpine/nodejs@22`), and a service that ships single-only.
 */
import { describe, expect, it } from 'vitest';

import { buildImportYaml, compareVersions, parseVersion, pickVersion, safeHostname, type CatalogEntry } from '../src/zerops/catalog.js';

const entry = (typeId: string, versions: string[]): CatalogEntry => ({ typeId, name: typeId, versions });

describe('parseVersion', () => {
  it('splits the managed-service form base:mode@version', () => {
    expect(parseVersion('postgresql:single@16')).toEqual({ base: 'postgresql', ha: false, version: '16' });
    expect(parseVersion('postgresql:ha@16')).toEqual({ base: 'postgresql', ha: true, version: '16' });
  });

  it('keeps a two-part version intact', () => {
    // The whole reason `valkey@7` fails: the version is 7.2, and truncating it is the bug.
    expect(parseVersion('valkey:single@7.2')?.version).toBe('7.2');
  });

  it('handles the runtime form with an OS prefix', () => {
    expect(parseVersion('alpine/nodejs@22')).toEqual({ base: 'nodejs', ha: false, version: '22' });
  });

  it('returns null on a shape it does not recognise, rather than half-parsing it', () => {
    expect(parseVersion('nonsense')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numerically, so 1.20 is newer than 1.9', () => {
    // A string sort puts "1.9" after "1.20" and would pick a two-year-old Meilisearch as
    // "latest". Meilisearch really does ship 1.10, 1.20 and 1.44 side by side.
    expect(compareVersions('1.20', '1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.44', '1.9')).toBeGreaterThan(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('16', '16.0')).toBe(0);
  });

  it('does not throw on a non-numeric segment', () => {
    expect(() => compareVersions('1.x', '1.2')).not.toThrow();
  });
});

describe('pickVersion', () => {
  it('picks the newest version, not the last one listed', () => {
    const e = entry('postgresql', ['postgresql:single@14', 'postgresql:single@18', 'postgresql:single@16']);
    expect(pickVersion(e, false)?.type).toBe('postgresql@18');
  });

  it('emits the IMPORT form, not the internal one', () => {
    // The platform stores `postgresql:single@16`; the import file wants `postgresql@16` plus
    // a separate mode. Sending the internal string back is rejected.
    const got = pickVersion(entry('postgresql', ['postgresql:single@16', 'postgresql:ha@16']), true);
    expect(got).toEqual({ type: 'postgresql@16', mode: 'HA' });
    expect(got?.type).not.toContain(':');
  });

  it('falls back to NON_HA when a service has no HA version at all', () => {
    // Meilisearch ships single-only. Asking for HA must not produce a request the platform
    // will reject; it must quietly give the mode that exists.
    const e = entry('meilisearch', ['meilisearch:single@1.10', 'meilisearch:single@1.44']);
    expect(pickVersion(e, true)).toEqual({ type: 'meilisearch@1.44', mode: 'NON_HA' });
  });

  it('honours HA when it is available', () => {
    expect(pickVersion(entry('valkey', ['valkey:single@7.2', 'valkey:ha@7.2']), true)?.mode).toBe('HA');
  });

  it('returns null for a type with no parseable versions', () => {
    expect(pickVersion(entry('weird', ['garbage']), false)).toBeNull();
    expect(pickVersion(entry('weird', []), false)).toBeNull();
  });
});

describe('safeHostname', () => {
  it('strips everything Zerops forbids', () => {
    // Documented: lowercase a-z and 0-9 only.
    expect(safeHostname('My-Service_01!')).toBe('myservice01');
  });

  it('truncates to the 25-character limit', () => {
    expect(safeHostname('a'.repeat(60))).toHaveLength(25);
  });

  it('avoids a collision with an existing service', () => {
    expect(safeHostname('db', ['db'])).toBe('db2');
    expect(safeHostname('db', ['db', 'db2'])).toBe('db3');
  });

  it('keeps the result within the limit even while de-duplicating', () => {
    // The suffix must eat into the name, not extend past 25 and be rejected on arrival.
    const taken = [ 'a'.repeat(25) ];
    const got = safeHostname('a'.repeat(30), taken);
    expect(got.length).toBeLessThanOrEqual(25);
    expect(taken).not.toContain(got);
  });

  it('never returns an empty hostname', () => {
    // A name made entirely of forbidden characters would otherwise clean to "".
    expect(safeHostname('!!!!')).toBe('svc');
  });
});

describe('buildImportYaml', () => {
  it('emits the exact shape the import endpoint accepts', () => {
    expect(buildImportYaml([{ hostname: 'db', type: 'postgresql@18', mode: 'NON_HA' }]))
      .toBe('services:\n  - hostname: db\n    type: postgresql@18\n    mode: NON_HA\n');
  });

  it('produces a valid empty document rather than a stray header', () => {
    expect(buildImportYaml([])).toBe('services:\n');
  });
});
