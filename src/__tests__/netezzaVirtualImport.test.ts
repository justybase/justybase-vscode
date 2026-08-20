import { Readable } from 'stream';

const mockRegisterImportStream = jest.fn();
const mockUnregisterImportStream = jest.fn();

jest.mock('../core/connectionFactory', () => ({
    getDatabaseConnectionConstructor: jest.fn(() => ({
        registerImportStream: mockRegisterImportStream,
        unregisterImportStream: mockUnregisterImportStream,
    })),
}));

import {
    buildNetezzaVirtualImportName,
    registerNetezzaImportStream,
} from '../import/netezzaVirtualImport';

describe('Netezza virtual import streams', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('registers the exact stream name used by FROM EXTERNAL and unregisters once', () => {
        const stream = Readable.from(['1\tAlice\n']);
        const name = buildNetezzaVirtualImportName('unit-import');
        const unregister = registerNetezzaImportStream(name, stream);

        expect(name).toMatch(/^unit-import_\d+_[a-z0-9]+\.txt$/);
        expect(mockRegisterImportStream).toHaveBeenCalledTimes(1);
        expect(mockRegisterImportStream).toHaveBeenCalledWith(name, stream);

        unregister();
        unregister();

        expect(mockUnregisterImportStream).toHaveBeenCalledTimes(1);
        expect(mockUnregisterImportStream).toHaveBeenCalledWith(name);
    });

    it('fails clearly when the active driver cannot unregister virtual streams', () => {
        const connectionFactory = jest.requireMock('../core/connectionFactory') as {
            getDatabaseConnectionConstructor: jest.Mock;
        };
        connectionFactory.getDatabaseConnectionConstructor.mockReturnValueOnce({
            registerImportStream: mockRegisterImportStream,
        });

        expect(() => registerNetezzaImportStream('missing-cleanup', Readable.from([])))
            .toThrow('does not support virtual import streams');
        expect(mockRegisterImportStream).not.toHaveBeenCalled();
    });
});
