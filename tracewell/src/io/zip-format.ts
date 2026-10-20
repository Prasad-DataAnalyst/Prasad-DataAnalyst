/**
 * Shared ZIP structure constants (PKWARE APPNOTE.TXT 6.3.10). The writer emits only what every
 * reader understands: no ZIP64, no data descriptors, no extra fields, no encryption. The reader
 * also accepts ZIP64 and data descriptors, which other producers of XLSX files use.
 */

export const SIG_LOCAL_HEADER = 0x04034b50;
export const SIG_CENTRAL_HEADER = 0x02014b50;
export const SIG_END_OF_CENTRAL_DIR = 0x06054b50;
export const SIG_ZIP64_END_OF_CENTRAL_DIR = 0x06064b50;
export const SIG_ZIP64_LOCATOR = 0x07064b50;

export const LOCAL_HEADER_BYTES = 30;
export const CENTRAL_HEADER_BYTES = 46;
export const END_OF_CENTRAL_DIR_BYTES = 22;
export const ZIP64_LOCATOR_BYTES = 20;
export const ZIP64_END_OF_CENTRAL_DIR_BYTES = 56;
/** The archive comment is at most 65,535 bytes, which bounds the search for the end record. */
export const MAX_COMMENT_BYTES = 0xffff;

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

export const FLAG_ENCRYPTED = 0x0001;
export const FLAG_STRONG_ENCRYPTION = 0x0040;
/** General-purpose bit 11: the file name is UTF-8. */
export const FLAG_UTF8_NAME = 0x0800;

/** Header ID of the ZIP64 extended information extra field. */
export const EXTRA_ZIP64 = 0x0001;

/** Version 2.0: the minimum for DEFLATE; 1.0 suffices for stored entries. */
export const VERSION_DEFLATE = 20;
export const VERSION_STORED = 10;
/** "Version made by": host system 0 (MS-DOS and FAT, so no Unix permissions), specification 2.0. */
export const VERSION_MADE_BY = 20;

/** Every entry is dated 1980-01-01 00:00:00, the earliest MS-DOS date, so output never depends on the clock. */
export const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
export const DOS_TIME_MIDNIGHT = 0;

export const MAX_U16 = 0xffff;
export const MAX_U32 = 0xffffffff;
