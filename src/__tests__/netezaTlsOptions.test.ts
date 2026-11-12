import { getNetezzaTlsDriverOptions } from '../core/netezzaTlsOptions';

describe('getNetezzaTlsDriverOptions', () => {
    it('keeps the driver default when the mode is absent or default', () => {
        expect(getNetezzaTlsDriverOptions(undefined)).toEqual({});
        expect(getNetezzaTlsDriverOptions({})).toEqual({});
        expect(getNetezzaTlsDriverOptions({ netezzaSslMode: 'default' })).toEqual({});
    });

    it('uses a CA path with the default negotiate mode', () => {
        expect(getNetezzaTlsDriverOptions({ netezzaSslRootCert: 'C:/certs/ca.pem' })).toEqual({
            sslCerFilePath: 'C:/certs/ca.pem'
        });
    });

    it('maps disable to a plaintext session', () => {
        expect(getNetezzaTlsDriverOptions({ netezzaSslMode: 'disable' })).toEqual({
            securityLevel: 'OnlyUnsecuredSession'
        });
    });

    it('maps require to encryption without certificate validation', () => {
        expect(getNetezzaTlsDriverOptions({ netezzaSslMode: 'require' })).toEqual({
            securityLevel: 'OnlySecuredSession',
            rejectUnauthorized: false
        });
    });

    it('maps verify-full to encryption plus certificate and hostname validation', () => {
        expect(
            getNetezzaTlsDriverOptions({
                netezzaSslMode: 'verify-full',
                netezzaSslRootCert: 'D:\\certs\\nz-ca.pem'
            })
        ).toEqual({
            securityLevel: 'OnlySecuredSession',
            rejectUnauthorized: true,
            sslCerFilePath: 'D:\\certs\\nz-ca.pem'
        });
    });

    it('accepts the sslMode / sslRootCert aliases for imported profiles', () => {
        expect(
            getNetezzaTlsDriverOptions({
                sslMode: 'verify-full',
                sslRootCert: 'C:/certs/ca.pem'
            })
        ).toEqual({
            securityLevel: 'OnlySecuredSession',
            rejectUnauthorized: true,
            sslCerFilePath: 'C:/certs/ca.pem'
        });
    });

    it('ignores unknown modes', () => {
        expect(getNetezzaTlsDriverOptions({ netezzaSslMode: 'bogus' })).toEqual({});
    });
});
