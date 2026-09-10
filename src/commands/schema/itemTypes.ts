/** Common, serializable data carried by schema tree command items. */
export interface SchemaItemData {
    label?: string;
    rawLabel?: string;
    dbName?: string;
    schema?: string;
    objType?: string;
    connectionName?: string;
    contextValue?: string;
    parentName?: string;
    objectDescription?: string;
    objId?: number;
}
