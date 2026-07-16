import { EventEmitter } from 'events';
import { createNzConnection, NzConnectionConfig } from '../core/nzConnectionFactory';

const mockNzConnectionConstructor = jest.fn();

jest.mock('@justybase/netezza-driver', () => ({
    NzConnection: mockNzConnectionConstructor
}));

describe('nzConnectionFactory', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('creates connection instance using driver constructor', () => {
        const mockConnection = new EventEmitter();
        mockNzConnectionConstructor.mockImplementation(() => mockConnection);

        const config: NzConnectionConfig = {
            host: 'localhost',
            port: 5480,
            database: 'TESTDB',
            user: 'admin',
            password: 'secret'
        };

        const connection = createNzConnection(config);

        expect(mockNzConnectionConstructor).toHaveBeenCalledWith({
            ...config,
            connectionTimeout: 5,
        });
        expect(connection).toBe(mockConnection);
    });

    it('supports config without optional port and password', () => {
        const mockConnection = new EventEmitter();
        mockNzConnectionConstructor.mockImplementation(() => mockConnection);

        const config: NzConnectionConfig = {
            host: 'db.internal',
            database: 'ANALYTICS',
            user: 'readonly'
        };

        const connection = createNzConnection(config);

        expect(mockNzConnectionConstructor).toHaveBeenCalledWith({
            ...config,
            connectionTimeout: 5,
        });
        expect(connection).toBe(mockConnection);
    });
});
