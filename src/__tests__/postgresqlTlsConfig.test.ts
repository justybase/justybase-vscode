import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseConnectionConfig } from '../contracts/database';
import { buildClientConfig } from '../../extensions/postgresql/src/postgresqlConnection';

function config(options: Record<string, string | number> = {}): DatabaseConnectionConfig {
    return {
        host: 'db.example.test',
        port: 5432,
        database: 'app',
        user: 'app_user',
        password: 'secret',
        options,
    };
}

describe('PostgreSQL TLS client configuration', () => {
    it('leaves TLS to pg defaults when no mode is selected', () => {
        expect(buildClientConfig(config()).ssl).toBeUndefined();
    });

    it('maps disable and require to pg TLS settings', () => {
        expect(buildClientConfig(config({ sslMode: 'disable' })).ssl).toBe(false);
        expect(buildClientConfig(config({ sslMode: 'require', sslServerName: 'db.example.test' })).ssl)
            .toEqual({ rejectUnauthorized: false, servername: 'db.example.test' });
    });

    it('enables chain and host name validation for verify-full', () => {
        const ssl = buildClientConfig(config({
            sslMode: 'verify-full',
            sslServerName: 'db.example.test',
        })).ssl as Record<string, unknown>;

        expect(ssl.rejectUnauthorized).toBe(true);
        expect(ssl.servername).toBe('db.example.test');
        expect(ssl.checkServerIdentity).toBeUndefined();
    });

    it('validates the chain without the host name for verify-ca', () => {
        const ssl = buildClientConfig(config({ sslMode: 'verify-ca' })).ssl as unknown as {
            rejectUnauthorized: boolean;
            checkServerIdentity?: () => undefined;
        };

        expect(ssl.rejectUnauthorized).toBe(true);
        expect(ssl.checkServerIdentity?.()).toBeUndefined();
    });

    it('loads a root CA and mutual TLS files', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'justybase-pg-tls-'));
        try {
            const caPath = path.join(directory, 'ca.pem');
            const certPath = path.join(directory, 'client.pem');
            const keyPath = path.join(directory, 'client.key');
            writeFileSync(caPath, 'CA-CONTENT', 'utf8');
            writeFileSync(certPath, 'CERT-CONTENT', 'utf8');
            writeFileSync(keyPath, 'KEY-CONTENT', 'utf8');

            const ssl = buildClientConfig(config({
                sslMode: 'verify-full',
                sslRootCert: caPath,
                sslCert: certPath,
                sslKey: keyPath,
            })).ssl as unknown as { ca: Buffer; cert: Buffer; key: Buffer };

            expect(ssl.ca.toString('utf8')).toBe('CA-CONTENT');
            expect(ssl.cert.toString('utf8')).toBe('CERT-CONTENT');
            expect(ssl.key.toString('utf8')).toBe('KEY-CONTENT');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('rejects half-configured mutual TLS and unreadable files', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'justybase-pg-tls-'));
        try {
            const certPath = path.join(directory, 'client.pem');
            writeFileSync(certPath, 'CERT-CONTENT', 'utf8');

            expect(() => buildClientConfig(config({
                sslMode: 'verify-full',
                sslCert: certPath,
            }))).toThrow('requires a client private key');
            expect(() => buildClientConfig(config({
                sslMode: 'verify-full',
                sslRootCert: path.join(directory, 'missing-ca.pem'),
            }))).toThrow('Failed to read PostgreSQL root CA certificate');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('converts the connection timeout to milliseconds', () => {
        expect(buildClientConfig(config({ connectTimeout: 12 })).connectionTimeoutMillis).toBe(12000);
    });
});
