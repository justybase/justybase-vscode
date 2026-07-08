import type { DatabaseConnectionFormSchema } from '../../contracts/database';

export const sqliteConnectionForm: DatabaseConnectionFormSchema = {
    fields: [
        {
            key: 'mode',
            label: 'Mode',
            type: 'select',
            storage: 'options',
            defaultValue: 'file',
            options: [
                {
                    value: 'file',
                    label: 'File path'
                },
                {
                    value: 'memory',
                    label: 'In-memory (:memory:)'
                }
            ],
            description: 'Choose whether to point at a SQLite file or use an in-memory database.',
            layout: 'full'
        },
        {
            key: 'database',
            label: 'Database Path',
            type: 'text',
            storage: 'topLevel',
            required: true,
            placeholder: 'Existing or new SQLite file (for example C:\\data\\sample.db)',
            description:
                'Existing or new SQLite file path. When Mode is set to In-memory, this field is auto-filled with :memory:. Supports local file and in-memory connections for query execution and SQL authoring.',
            layout: 'full'
        }
    ]
};
