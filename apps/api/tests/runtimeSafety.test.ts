import { isReadOnlySql } from '@justybase/database-runtime';
import { loadConfig } from '../src/config';

describe('web runtime safety', () => {
  it('validates every statement submitted to a read-only connection', () => {
    expect(isReadOnlySql('SELECT 1; SELECT 2')).toBe(true);
    expect(isReadOnlySql("SELECT ';' AS separator; -- harmless ;\nSHOW DATABASE")).toBe(true);
    expect(isReadOnlySql('SELECT 1; CALL write_proc()')).toBe(false);
    expect(isReadOnlySql('SELECT 1; EXECUTE PROCEDURE write_proc()')).toBe(false);
    expect(isReadOnlySql('WITH deleted AS (DELETE FROM T RETURNING *) SELECT * FROM deleted')).toBe(false);
    expect(isReadOnlySql('SELECT 1; /* unterminated')).toBe(false);
  });

  it('prefers the documented JustyBase host and port variables', () => {
    const config = loadConfig({ NODE_ENV: 'test', JUSTYBASE_HOST: '0.0.0.0', JUSTYBASE_PORT: '4321', HOST: '127.0.0.2', PORT: '9999' });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(4321);
  });
});
