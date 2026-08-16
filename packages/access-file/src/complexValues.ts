import { ACCESS_COMPLEX_KIND } from './types';
import type {
    AccessAttachment,
    AccessComplexValue,
    AccessSingleValue,
    AccessVersion,
} from './types';

function isAttachment(value: AccessComplexValue[number]): value is AccessAttachment {
    return 'data' in value && 'name' in value && 'type' in value;
}

function isVersion(value: AccessComplexValue[number]): value is AccessVersion {
    return 'modified' in value;
}

function attachmentJson(value: AccessAttachment): object {
    return {
        FileData: value.data === null ? null : Array.from(value.data),
        FileFlags: value.flags,
        FileName: value.name,
        FileTimeStamp: value.timestamp,
        FileType: value.type,
        FileURL: value.url,
    };
}

/**
 * Serializes a complex value using the same envelope as the C# mirror:
 * `{ "Kind": "single|attachment|version", "Values": [...] }`.
 */
export function serializeAccessComplexValue(value: AccessComplexValue): string {
    const first = value[0];
    const kind = value[ACCESS_COMPLEX_KIND];
    if (kind === 'attachment' || (first && value.every(isAttachment))) {
        const attachments = value as readonly AccessAttachment[];
        return JSON.stringify({
            Kind: 'attachment',
            Values: attachments.map(item => attachmentJson(item)),
        });
    }
    if (kind === 'version' || (first && value.every(isVersion))) {
        const versions = value as readonly AccessVersion[];
        return JSON.stringify({
            Kind: 'version',
            Values: versions.map(item => ({
                Value: item.value,
                Modified: item.modified,
            })),
        });
    }
    return JSON.stringify({
        Kind: 'single',
        Values: value.map(item => (item as AccessSingleValue).value),
    });
}
