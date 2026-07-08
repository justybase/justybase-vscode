export type DatabaseConnectionOptionValue = string | number | boolean;

export type DatabaseConnectionOptions = Record<string, DatabaseConnectionOptionValue>;

export type DatabaseConnectionFieldType = 'text' | 'password' | 'number' | 'select' | 'checkbox';

export interface DatabaseConnectionFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface DatabaseConnectionFieldSchema {
  key: string;
  label: string;
  type: DatabaseConnectionFieldType;
  storage?: 'topLevel' | 'options';
  required?: boolean;
  placeholder?: string;
  description?: string;
  defaultValue?: DatabaseConnectionOptionValue;
  min?: number;
  max?: number;
  layout?: 'full' | 'half';
  options?: readonly DatabaseConnectionFieldOption[];
}

export interface DatabaseConnectionFormSchema {
  fields: readonly DatabaseConnectionFieldSchema[];
}
