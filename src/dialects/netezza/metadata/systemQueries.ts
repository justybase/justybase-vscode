/**
 * Netezza System Views and Queries
 * 
 * This module centralizes all references to Netezza system catalog views.
 * Use these constants and query builders throughout the codebase to ensure
 * consistency and make maintenance/updates easier.
 * 
 * System views documentation:
 * - Views prefixed with _V_ are virtual system views
 * - Most views exist per-database (accessed as SAMPLE_DB.._V_VIEWNAME)
 * - Some global views are in SYSTEM database (SYSTEM.._V_DATABASE)
 * 
 * ============================================================================
 * CRITICAL NOTES ABOUT NETEZZA SYSTEM VIEW LIMITATIONS:
 * ============================================================================
 * 
 * 1. _V_OBJECT_DATA - DESCRIPTION column limitation:
 *    -------------------------------------------------
 *    When querying SAMPLE_DB.._V_OBJECT_DATA:
 *    - It returns objects from ALL databases (not just SAMPLE_DB)
 *    - BUT: The DESCRIPTION column is ONLY populated for objects belonging to SAMPLE_DB!
 *    - Objects from other databases will have NULL/empty DESCRIPTION values
 *    
 *    Solution: Always use WHERE DBNAME = 'SAMPLE_DB' dont user _V_OBJECT_DATA without "SAMPLE_DB.." prefix and filter when you need descriptions.
 * 
 * 2. _V_VIEW - DEFINITION column limitation:
 *    ----------------------------------------
 *    The DEFINITION column (view SQL source code) is ONLY accessible when:
 *    - The connection is established TO THE SAME DATABASE where the view exists!
 *    - Using SAMPLE_DB.._V_VIEW is NOT enough - you must BE CONNECTED to SAMPLE_DB
 *    
 *    Example: If connected to SYSTEM database and query MYDB.._V_VIEW,
 *    the DEFINITION column will be NULL/empty/placeholder("not a view") even though the view exists.
 *    
 *    Solution: To get view definitions, ensure the connection's current database
 *    matches the database containing the view.
 
Sample:
QUERY:
SELECT OBJID, VIEWNAME, OWNER, CREATEDATE, OBJTYPE, OBJCLASS, DESCRIPTION, RELHASINDEX, RELKIND, RELCHECKS, RELTRIGGERS, RELHASRULES, RELUKEYS, RELFKEYS, RELREFS, RELHASPKEY, RELNATTS, DEFINITION, OBJDELIM, DATABASE, OBJDB, SCHEMA, SCHEMAID
FROM SAMPLE_DB.._V_VIEW 
WHERE DATABASE = 'SAMPLE_DB'

RESULT:
[
  {
    "OBJID": "200428",
    "VIEWNAME": "VDMPREP",
    "OWNER": "ADMIN",
    "CREATEDATE": "2001-01-01 12:00:00",
    "OBJTYPE": "VIEW",
    "OBJCLASS": "4906",
    "DESCRIPTION": null,
    "RELHASINDEX": "f",
    "RELKIND": "v",
    "RELCHECKS": "0",
    "RELTRIGGERS": "0",
    "RELHASRULES": "t",
    "RELUKEYS": "0",
    "RELFKEYS": "0",
    "RELREFS": "0",
    "RELHASPKEY": "f",
    "RELNATTS": "13",
    "DEFINITION": "SELECT PC.ENGLISHPRODUCTCATEGORYNAME, CASE WHEN .... ;",
    "OBJDELIM": "f",
    "DATABASE": "SAMPLE_DB",
    "OBJDB": "200399",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "200398"
  },
  ...
]

 * 3. _V_PROCEDURE does NOT have this limitation - PROCEDURESOURCE is accessible cross-database without needing to connect to the specific database. But "DATABASE.." prefix is still needed to get the procedure metadata.
 * dont user _V_PROCEDURE without "DATABASE.." prefix.
 * sample:
 * QUERY:
 SELECT
  OBJID,  PROCEDURE,  OWNER,  CREATEDATE,  OBJTYPE,
  DESCRIPTION,  RESULT,  NUMARGS,  ARGUMENTS,  PROCEDURESIGNATURE,
  BUILTIN,  VARARGS,  PROCEDURESOURCE,  SPROC,  EXECUTEDASOWNER,
  RETURNS,  DATABASE,  DATABASEID,  SCHEMA, SCHEMAID
  FROM SAMPLE_DB.._V_PROCEDURE
  WHERE DATABASE = 'SAMPLE_DB';
 
  RESULT:
[
  {
    "OBJID": "200680",
    "PROCEDURE": "CUSTOMER_DOTNET",
    "OWNER": "ADMIN",
    "CREATEDATE": "2001-01-01 12:00:00",
    "OBJTYPE": "PROCEDURE",
    "DESCRIPTION": null,
    "RESULT": "INTEGER",
    "NUMARGS": "0",
    "ARGUMENTS": "()",
    "PROCEDURESIGNATURE": "CUSTOMER_DOTNET()",
    "BUILTIN": "f",
    "VARARGS": "f",
    "PROCEDURESOURCE": " BEGIN RAISE NOTICE 'The customer name is alpha'; RAISE NOTICE 'The customer location is beta'; END; ",
    "SPROC": "t",
    "EXECUTEDASOWNER": "t",
    "RETURNS": "INTEGER",
    "DATABASE": "SAMPLE_DB",
    "DATABASEID": "200399",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "200398"
  },
  ...
]

* 4._V_RELATION_COLUMN always use SELECT * FROM SAMPLE_DB.._V_RELATION_COLUMN will return objects from "SAMPLE_DB" + SYSTEM databases only, IMPORTANT: DESCRIPTION column is accessible even when connected to a different database, but dont use without "DATABASE.."
* each database has its own _V_RELATION_COLUMN, so you can use SELECT * FROM DATABASE.._V_RELATION_COLUMN or prepare query with union all to get all databases
* sample:
SELECT
  OBJID,  NAME,  OWNER,  CREATEDATE,  TYPE,
  DATABASE, ATTNUM, ATTNAME, COLID, DESCRIPTION, FORMAT_TYPE, ATTNOTNULL, ATTTYPID, ATTTYPMOD, ATTLEN, ATTDISPERSION, COLDEFAULT, ATTCOLLENG, ATTDELIM, 
  ZMAPPED, OBJCLASS, RELRESTOREDOID, OBJDELIM, ATTVERSTATUS, ATTORIGOID, ATTRESTOREDOID, OBJDB, SCHEMA, SCHEMAID
  FROM SAMPLE_DB.._V_RELATION_COLUMN
  WHERE DATABASE = 'SAMPLE_DB';
[
{
    "OBJID": "202941",
    "NAME": "DIMDATE",
    "OWNER": "ADMIN",
    "CREATEDATE": "2001-01-01 12:00:00",
    "TYPE": "TABLE",
    "DATABASE": "SAMPLE_DB",
    "ATTNUM": "1",
    "ATTNAME": "DATEKEY",
    "COLID": "214801",
    "DESCRIPTION": "Primary key for this table, used in foreign key relationships with fact tables.",
    "FORMAT_TYPE": "INTEGER",
    "ATTNOTNULL": "f",
    "ATTTYPID": "23",
    "ATTTYPMOD": "-1",
    "ATTLEN": "4",
    "ATTDISPERSION": "0",
    "COLDEFAULT": null,
    "ATTCOLLENG": "4",
    "ATTDELIM": "f",
    "ZMAPPED": "t",
    "OBJCLASS": "4905",
    "RELRESTOREDOID": "0",
    "OBJDELIM": "f",
    "ATTVERSTATUS": "0",
    "ATTORIGOID": "0",
    "ATTRESTOREDOID": "0",
    "OBJDB": "202940",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "202939"
  },
  ...
  
  5. _V_EXTERNAL // External table definitions, dont use without "SAMPLE_DB.." prefix
  SELECT * FROM  SAMPLE_DB.._V_EXTERNAL WHERE DATABASE = 'SAMPLE_DB';
  -> 
[
  {
    "RELID": "201634",
    "TABLENAME": "SAMPLE_NAME",
    "MAXERRORS": "1",
    "DELIM": "|",
    "REJECTFILE": null,
    "DATESTYLE": "YMD",
    "CODESET": null,
    "QUOTEDVALUE": "NO",
    "NULLVALUE": "NULL",
    "ESCAPE": null,
    "CRINSTRING": null,
    "TRUNCSTRING": null,
    "DATEDELIM": "-",
    "TIMESTYLE": "24HOUR",
    "TIMEDELIM": ":",
    "BOOLSTYLE": "1_0",
    "CTRLCHARS": null,
    "DISTSTATS": null,
    "LOGDIR": "/tmp",
    "MAXROWS": null,
    "REQUIREQUOTES": null,
    "IGNOREZERO": null,
    "TIMEEXTRAZEROS": null,
    "Y2BASE": null,
    "FILLRECORD": null,
    "FORMAT": "TEXT",
    "COMPRESS": "FALSE",
    "ENCODING": "INTERNAL",
    "REMOTESOURCE": "JDBC",
    "SOCKETBUFSIZE": "8388608",
    "ADJUSTDISTZEROINT": null,
    "SKIPROWS": null,
    "INCLUDEZEROSECONDS": null,
    "RECORDLENGTH": null,
    "RECORDDELIM": "\n",
    "NULLINDICATOR": null,
    "LAYOUT": null,
    "DECIMALDELIM": null,
    "LOGFILE": null,
    "BADFILE": null,
    "DISABLENFC": null,
    "INCLUDEHEADER": null,
    "DATETIMEDELIM": " ",
    "MERIDIANDELIM": " ",
    "LFINSTRING": null,
    "CLOUD_CONNSTRING": null,
    "DATABASE": "SAMPLE_DB",
    "OBJDB": "200399",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "200398"
  }
]
6. _V_EXTOBJECT // External table objects, dont use without "SAMPLE_DB.." prefix
SELECT * FROM  SAMPLE_DB.._V_EXTOBJECT WHERE DATABASE = 'SAMPLE_DB';
-->
[
  {
    "OBJID": "201634",
    "TABLENAME": "SAMPLE_NAME",
    "OWNER": "ADMIN",
    "CREATEDATE": "2001-01-01 12:00:00",
    "OBJTYPE": "EXTERNAL TABLE",
    "OBJCLASS": "4911",
    "OBJNO": "1",
    "EXTOBJNAME": "D:\\TMP\\DIMDATE.dat",
    "DATABASE": "SAMPLE_DB",
    "OBJDB": "200399",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "200398"
  }
]

7. SELECT * FROM _V_DATABASE
-> 
[
  {
    "OBJID": "200399",
    "DATABASE": "SAMPLE_DB",
    "OWNER": "ADMIN",
    "CREATEDATE": "2001-01-01 12:00:00",
    "DB_CHARSET": "LATIN9",
    "DB_COLLATION": "BINARY",
    "DBCHARSET": "4960",
    "DBCOLLATION": "4970",
    "DBOWNERID": "1000",
    "DBLOCKPID": "0",
    "DBSTATUS": null,
    "BACKUPGROUP": null,
    "OBJDELIM": "f",
    "DBCOLLECTHISTORY": "t",
    "ENCODING": "0",
    "DEFSCHEMAID": "200398",
    "DEFSCHEMA": "ADMIN",
    "NCHARENCODING": "0",
    "NCHARSET": "UTF8",
    "DBTRACKCHANGES": "1",
    "DATAVERRETNTIME": "0",
    "GROOMBACKUPSET": "0",
    "DATAVERRETNLOWERBOUND": null
  },
  {
    "OBJID": "202940",
    "DATABASE": "SAMPLE_DB_1",
    "OWNER": "ADMIN",
    "CREATEDATE": "2001-01-01 12:00:00",
    "DB_CHARSET": "LATIN9",
    "DB_COLLATION": "BINARY",
    "DBCHARSET": "4960",
    "DBCOLLATION": "4970",
    "DBOWNERID": "1000",
    "DBLOCKPID": "0",
    "DBSTATUS": null,
    "BACKUPGROUP": null,
    "OBJDELIM": "f",
    "DBCOLLECTHISTORY": "t",
    "ENCODING": "0",
    "DEFSCHEMAID": "202939",
    "DEFSCHEMA": "ADMIN",
    "NCHARENCODING": "0",
    "NCHARSET": "UTF8",
    "DBTRACKCHANGES": "1",
    "DATAVERRETNTIME": "0",
    "GROOMBACKUPSET": "0",
    "DATAVERRETNLOWERBOUND": null
  },
  {
    "OBJID": "1",
    "DATABASE": "SYSTEM",
    "OWNER": "ADMIN",
    "CREATEDATE": "2001-01-01 12:00:00",
    "DB_CHARSET": "LATIN9",
    "DB_COLLATION": "BINARY",
    "DBCHARSET": "4960",
    "DBCOLLATION": "4970",
    "DBOWNERID": "1000",
    "DBLOCKPID": "0",
    "DBSTATUS": null,
    "BACKUPGROUP": null,
    "OBJDELIM": "f",
    "DBCOLLECTHISTORY": "t",
    "ENCODING": "0",
    "DEFSCHEMAID": "6",
    "DEFSCHEMA": "ADMIN",
    "NCHARENCODING": "0",
    "NCHARSET": "UTF8",
    "DBTRACKCHANGES": "0",
    "DATAVERRETNTIME": "0",
    "GROOMBACKUPSET": "0",
    "DATAVERRETNLOWERBOUND": null
  }
]

*8. SELECT * FROM SAMPLE_DB.._V_SCHEMA WHERE DATABASE = 'SAMPLE_DB';
-> 
[
  {
    "SCHEMAID": "200398",
    "DATABASEID": "200399",
    "DATABASE": "SAMPLE_DB",
    "SCHEMA": "ADMIN",
    "OWNER": "ADMIN",
    "CREATEDATE": "2001-01-01 12:00:00",
    "OBJDELIM": "f",
    "SQLPATH": null,
    "DATAVERRETNTIME": "0",
    "DATAVERRETNLOWERBOUND": null
  },
  {
    "SCHEMAID": "4",
    "DATABASEID": "200399",
    "DATABASE": "SAMPLE_DB",
    "SCHEMA": "DEFINITION_SCHEMA",
    "OWNER": "ADMIN",
    "CREATEDATE": "2001-01-01 12:00:00",
    "OBJDELIM": "f",
    "SQLPATH": null,
    "DATAVERRETNTIME": "0",
    "DATAVERRETNLOWERBOUND": null
  },
  {
    "SCHEMAID": "5",
    "DATABASEID": "200399",
    "DATABASE": "SAMPLE_DB",
    "SCHEMA": "INFORMATION_SCHEMA",
    "OWNER": "ADMIN",
    "CREATEDATE": "2001-01-01 12:00:00",
    "OBJDELIM": "f",
    "SQLPATH": null,
    "DATAVERRETNTIME": "0",
    "DATAVERRETNLOWERBOUND": null
  }
]

9.SELECT * FROM SAMPLE_DB.._V_RELATION_KEYDATA WHERE DATABASE = 'SAMPLE_DB';
->
[
  {
    "DATABASE": "SAMPLE_DB",
    "SCHEMA": "ADMIN",
    "OWNER": "ADMIN",
    "RELATION": "DIMDATE",
    "CONSTRAINTNAME": "PK_DIMDATE",
    "CONTYPE": "p",
    "CONSEQ": "1",
    "ATTNAME": "DATEKEY",
    "PKDATABASEID": null,
    "PKSCHEMAID": null,
    "PKDATABASE": null,
    "PKSCHEMA": null,
    "PKOWNER": null,
    "PKRELATION": null,
    "PKCONSEQ": null,
    "PKATTNAME": null,
    "UPDT_TYPE": null,
    "DEL_TYPE": null,
    "MATCH_TYPE": null,
    "DEFERRABLE": "NOT DEFERRABLE",
    "DEFERRED": "INITIALLY IMMEDIATE",
    "CONSTR_OID": "209034",
    "OBJID": "209023",
    "OBJDB": "200399",
    "SCHEMAID": "200398",
    "OBJDELIM": "f",
    "RELRESTOREDOID": "0",
    "PKRESTOREDOID": null,
    "PKOBJID": "0",
    "ATTDELIM": "f",
    "PKATTDELIM": null,
    "DEFERRABLECONSTR": "NOT DEFERRABLE",
    "RELDELIM": "f",
    "REFDELIM": null,
    "REFCONSTRNAME": null
  },
  {
    "DATABASE": "SAMPLE_DB",
    "SCHEMA": "ADMIN",
    "OWNER": "ADMIN",
    "RELATION": "FACT_SALES",
    "CONSTRAINTNAME": "FK_SALES_DATE",
    "CONTYPE": "f",
    "CONSEQ": "1",
    "ATTNAME": "SALE_DATE_ID",
    "PKDATABASEID": "200399",
    "PKSCHEMAID": "200398",
    "PKDATABASE": "SAMPLE_DB",
    "PKSCHEMA": "ADMIN",
    "PKOWNER": "ADMIN",
    "PKRELATION": "DIMDATE",
    "PKCONSEQ": "1",
    "PKATTNAME": "DATEKEY",
    "UPDT_TYPE": "NO ACTION",
    "DEL_TYPE": "NO ACTION",
    "MATCH_TYPE": "UNSPECIFIED",
    "DEFERRABLE": "NOT DEFERRABLE",
    "DEFERRED": "INITIALLY IMMEDIATE",
    "CONSTR_OID": "209038",
    "OBJID": "209036",
    "OBJDB": "200399",
    "SCHEMAID": "200398",
    "OBJDELIM": "f",
    "RELRESTOREDOID": "0",
    "PKRESTOREDOID": "0",
    "PKOBJID": "209023",
    "ATTDELIM": "f",
    "PKATTDELIM": "f",
    "DEFERRABLECONSTR": "NOT DEFERRABLE",
    "RELDELIM": "f",
    "REFDELIM": "f",
    "REFCONSTRNAME": "PK_DIMDATE"
  },
  {
    "DATABASE": "SAMPLE_DB",
    "SCHEMA": "ADMIN",
    "OWNER": "ADMIN",
    "RELATION": "DIMDATE_NNT",
    "CONSTRAINTNAME": "PK_DIMDATE_NNT",
    "CONTYPE": "p",
    "CONSEQ": "1",
    "ATTNAME": "DATEKEY",
    "PKDATABASEID": null,
    "PKSCHEMAID": null,
    "PKDATABASE": null,
    "PKSCHEMA": null,
    "PKOWNER": null,
    "PKRELATION": null,
    "PKCONSEQ": null,
    "PKATTNAME": null,
    "UPDT_TYPE": null,
    "DEL_TYPE": null,
    "MATCH_TYPE": null,
    "DEFERRABLE": "NOT DEFERRABLE",
    "DEFERRED": "INITIALLY IMMEDIATE",
    "CONSTR_OID": "207011",
    "OBJID": "207008",
    "OBJDB": "200399",
    "SCHEMAID": "200398",
    "OBJDELIM": "f",
    "RELRESTOREDOID": "0",
    "PKRESTOREDOID": null,
    "PKOBJID": "0",
    "ATTDELIM": "f",
    "PKATTDELIM": null,
    "DEFERRABLECONSTR": "NOT DEFERRABLE",
    "RELDELIM": "f",
    "REFDELIM": null,
    "REFCONSTRNAME": null
  },
  {
    "DATABASE": "SAMPLE_DB",
    "SCHEMA": "ADMIN",
    "OWNER": "ADMIN",
    "RELATION": "FACTSURVEYRESPONSE",
    "CONSTRAINTNAME": "FK_DATE",
    "CONTYPE": "f",
    "CONSEQ": "1",
    "ATTNAME": "DATEKEY",
    "PKDATABASEID": "200399",
    "PKSCHEMAID": "200398",
    "PKDATABASE": "SAMPLE_DB",
    "PKSCHEMA": "ADMIN",
    "PKOWNER": "ADMIN",
    "PKRELATION": "DIMDATE",
    "PKCONSEQ": "1",
    "PKATTNAME": "DATEKEY",
    "UPDT_TYPE": "NO ACTION",
    "DEL_TYPE": "NO ACTION",
    "MATCH_TYPE": "UNSPECIFIED",
    "DEFERRABLE": "NOT DEFERRABLE",
    "DEFERRED": "INITIALLY IMMEDIATE",
    "CONSTR_OID": "209041",
    "OBJID": "200425",
    "OBJDB": "200399",
    "SCHEMAID": "200398",
    "OBJDELIM": "f",
    "RELRESTOREDOID": "0",
    "PKRESTOREDOID": "0",
    "PKOBJID": "209023",
    "ATTDELIM": "f",
    "PKATTDELIM": "f",
    "DEFERRABLECONSTR": "NOT DEFERRABLE",
    "RELDELIM": "f",
    "REFDELIM": "f",
    "REFCONSTRNAME": "PK_DIMDATE"
  },
  {
    "DATABASE": "SAMPLE_DB",
    "SCHEMA": "ADMIN",
    "OWNER": "ADMIN",
    "RELATION": "DIMCUSTOMER",
    "CONSTRAINTNAME": "PK_DIMCUSTOMER",
    "CONTYPE": "p",
    "CONSEQ": "1",
    "ATTNAME": "CUSTOMERKEY",
    "PKDATABASEID": null,
    "PKSCHEMAID": null,
    "PKDATABASE": null,
    "PKSCHEMA": null,
    "PKOWNER": null,
    "PKRELATION": null,
    "PKCONSEQ": null,
    "PKATTNAME": null,
    "UPDT_TYPE": null,
    "DEL_TYPE": null,
    "MATCH_TYPE": null,
    "DEFERRABLE": "NOT DEFERRABLE",
    "DEFERRED": "INITIALLY IMMEDIATE",
    "CONSTR_OID": "209045",
    "OBJID": "209044",
    "OBJDB": "200399",
    "SCHEMAID": "200398",
    "OBJDELIM": "f",
    "RELRESTOREDOID": "0",
    "PKRESTOREDOID": null,
    "PKOBJID": "0",
    "ATTDELIM": "f",
    "PKATTDELIM": null,
    "DEFERRABLECONSTR": "NOT DEFERRABLE",
    "RELDELIM": "f",
    "REFDELIM": null,
    "REFCONSTRNAME": null
  },
  {
    "DATABASE": "SAMPLE_DB",
    "SCHEMA": "ADMIN",
    "OWNER": "ADMIN",
    "RELATION": "FACTSURVEYRESPONSE",
    "CONSTRAINTNAME": "FK_CUSTOMER",
    "CONTYPE": "f",
    "CONSEQ": "1",
    "ATTNAME": "CUSTOMERKEY",
    "PKDATABASEID": "200399",
    "PKSCHEMAID": "200398",
    "PKDATABASE": "SAMPLE_DB",
    "PKSCHEMA": "ADMIN",
    "PKOWNER": "ADMIN",
    "PKRELATION": "DIMCUSTOMER",
    "PKCONSEQ": "1",
    "PKATTNAME": "CUSTOMERKEY",
    "UPDT_TYPE": "NO ACTION",
    "DEL_TYPE": "NO ACTION",
    "MATCH_TYPE": "UNSPECIFIED",
    "DEFERRABLE": "NOT DEFERRABLE",
    "DEFERRED": "INITIALLY IMMEDIATE",
    "CONSTR_OID": "209047",
    "OBJID": "200425",
    "OBJDB": "200399",
    "SCHEMAID": "200398",
    "OBJDELIM": "f",
    "RELRESTOREDOID": "0",
    "PKRESTOREDOID": "0",
    "PKOBJID": "209044",
    "ATTDELIM": "f",
    "PKATTDELIM": "f",
    "DEFERRABLECONSTR": "NOT DEFERRABLE",
    "RELDELIM": "f",
    "REFDELIM": "f",
    "REFCONSTRNAME": "PK_DIMCUSTOMER"
  }
]

10. SELECT * FROM SAMPLE_DB.._V_TABLE_DIST_MAP WHERE DATABASE = 'SAMPLE_DB';

[
  {
    "OBJID": "209036",
    "TABLENAME": "FACT_SALES",
    "OWNER": "ADMIN",
    "CREATEDATE": "2000-01-01 00:00:00",
    "DISTSEQNO": "1",
    "DISTATTNUM": "1",
    "ATTNUM": "1",
    "ATTNAME": "SALE_ID",
    "DATABASE": "SAMPLE_DB",
    "OBJDB": "200399",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "200398"
  },
  {
    "OBJID": "204880",
    "TABLENAME": "NEW_CREATED_TABLE",
    "OWNER": "ADMIN",
    "CREATEDATE": "2000-01-01 00:00:00",
    "DISTSEQNO": "1",
    "DISTATTNUM": "1",
    "ATTNUM": "1",
    "ATTNAME": "CREATION_DATE_TIME",
    "DATABASE": "SAMPLE_DB",
    "OBJDB": "200399",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "200398"
  },
  {
    "OBJID": "204895",
    "TABLENAME": "T5",
    "OWNER": "ADMIN",
    "CREATEDATE": "2000-01-01 00:00:00",
    "DISTSEQNO": "1",
    "DISTATTNUM": "1",
    "ATTNUM": "1",
    "ATTNAME": "C1",
    "DATABASE": "SAMPLE_DB",
    "OBJDB": "200399",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "200398"
  },
  {
    "OBJID": "205132",
    "TABLENAME": "DIMDATE_IMPORT_TEST",
    "OWNER": "ADMIN",
    "CREATEDATE": "2000-01-01 00:00:00",
    "DISTSEQNO": "1",
    "DISTATTNUM": "1",
    "ATTNUM": "1",
    "ATTNAME": "DATEKEY",
    "DATABASE": "SAMPLE_DB",
    "OBJDB": "200399",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "200398"
  },
  {
    "OBJID": "205136",
    "TABLENAME": "DIMACCOUNT_IMPORT_TEST",
    "OWNER": "ADMIN",
    "CREATEDATE": "2000-01-01 00:00:00",
    "DISTSEQNO": "1",
    "DISTATTNUM": "1",
    "ATTNUM": "1",
    "ATTNAME": "ACCOUNTKEY",
    "DATABASE": "SAMPLE_DB",
    "OBJDB": "200399",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "200398"
  },
  {
    "OBJID": "203919",
    "TABLENAME": "DIMACCOUNT_TMP",
    "OWNER": "ADMIN",
    "CREATEDATE": "2000-01-01 00:00:00",
    "DISTSEQNO": "1",
    "DISTATTNUM": "1",
    "ATTNUM": "1",
    "ATTNAME": "ACCOUNTKEY",
    "DATABASE": "SAMPLE_DB",
    "OBJDB": "200399",
    "SCHEMA": "ADMIN",
    "SCHEMAID": "200398"
  }
]

 * ============================================================================
 */

// =============================================================================
// SYSTEM VIEW NAMES
// =============================================================================

import { isQuotedIdentifier, requiresIdentifierQuoting, unquoteIdentifier } from '../../../utils/identifierUtils';

export const NZ_SYSTEM_VIEWS = {
    // Object/table related
    OBJECT_DATA: '_V_OBJECT_DATA',           // All objects (tables, views, etc.) with metadata, dont use without "SAMPLE_DB.." prefix and filter when you need descriptions.
    TABLE: '_V_TABLE',                        // Tables and views basic info, SELECT * FROM SAMPLE_DB.._V_TABLE returns objects from "SAMPLE_DB" + SYSTEM databases only
    VIEW: '_V_VIEW',                          // View definitions, SELECT * FROM SAMPLE_DB.._V_VIEW returns objects from "SAMPLE_DB" + SYSTEM databases only,IMPORTANT: DEFINITION column is only accessible when connected to the same database as the view
    PROCEDURE: '_V_PROCEDURE',                // Stored procedures, SELECT * FROM SAMPLE_DB.._V_PROCEDURE returns objects from "SAMPLE_DB" + SYSTEM databases only,IMPORTANT: PROCEDURESOURCE is accessible even when connected to a different database, but dont use without "SAMPLE_DB.." prefix
    SYNONYM: '_V_SYNONYM',                    // Synonyms, dont use without "SAMPLE_DB.." prefix

    // Column/structure related
    RELATION_COLUMN: '_V_RELATION_COLUMN',    // Column definitions for tables/views, dont use without "SAMPLE_DB.." prefix
    RELATION_KEYDATA: '_V_RELATION_KEYDATA',  // Primary/Foreign/Unique key definitions, dont use without "SAMPLE_DB.." prefix
    TABLE_DIST_MAP: '_V_TABLE_DIST_MAP',      // Distribution key information, dont use without "SAMPLE_DB.." prefix
    TABLE_ORGANIZE_COLUMN: '_V_TABLE_ORGANIZE_COLUMN', // Clustering/organize columns, dont use without "SAMPLE_DB.." prefix

    // External tables
    EXTERNAL: '_V_EXTERNAL',                  // External table definitions, dont use without "SAMPLE_DB.." prefix
    EXTOBJECT: '_V_EXTOBJECT',                // External object metadata (data source paths), dont use without "SAMPLE_DB.." prefix

    // Database/schema
    DATABASE: '_V_DATABASE',                  // All databases, SHOULD be used without "SAMPLE_DB.." prefix 
    SCHEMA: '_V_SCHEMA',                      // Schemas within a database,  dont use without "SAMPLE_DB.." prefix
} as const;


/**
 * Object types used in OBJTYPE column
 */
export const NZ_OBJECT_TYPES = {
    TABLE: 'TABLE',
    VIEW: 'VIEW',
    MATERIALIZED_VIEW: 'MATERIALIZED VIEW',
    EXTERNAL_TABLE: 'EXTERNAL TABLE',
    PROCEDURE: 'PROCEDURE',
    SEQUENCE: 'SEQUENCE',
    SYSTEM_VIEW: 'SYSTEM VIEW',
    SYSTEM_TABLE: 'SYSTEM TABLE',
    SYNONYM: 'SYNONYM',
    GLOBAL_TEMP_TABLE: 'GLOBAL TEMP TABLE',
} as const;

/**
 * Default object types for schema tree navigation.
 * Used as fallback when typeGroups are not yet cached.
 * This enables instant "Reveal in Schema" without database queries.
 */
export const NZ_DEFAULT_OBJECT_TYPES: readonly string[] = [
    'TABLE',
    'VIEW',
    'EXTERNAL TABLE',
    'PROCEDURE',
    'SEQUENCE',
    'SYNONYM',
    'SYSTEM TABLE',
    'SYSTEM VIEW',
    'MATERIALIZED VIEW',
    'GLOBAL TEMP TABLE',
] as const;

/** Object types loaded into tableCache during connection prefetch (disk-persisted). */
export const NZ_PREFETCH_CATALOG_OBJECT_TYPES: readonly string[] = [
    NZ_OBJECT_TYPES.TABLE,
    NZ_OBJECT_TYPES.VIEW,
    NZ_OBJECT_TYPES.EXTERNAL_TABLE,
    NZ_OBJECT_TYPES.SYNONYM,
    NZ_OBJECT_TYPES.SEQUENCE,
    NZ_OBJECT_TYPES.MATERIALIZED_VIEW,
    NZ_OBJECT_TYPES.SYSTEM_VIEW,
    NZ_OBJECT_TYPES.GLOBAL_TEMP_TABLE,
] as const;

/**
 * Constraint types in _V_RELATION_KEYDATA
 */
export const NZ_CONSTRAINT_TYPES = {
    PRIMARY_KEY: 'p',
    FOREIGN_KEY: 'f',
    UNIQUE: 'u',
} as const;

// =============================================================================
// QUERY BUILDERS
// =============================================================================

/**
 * Build fully qualified system view name: DATABASE..VIEW_NAME
 * @param database Database name
 * @param viewName System view name from NZ_SYSTEM_VIEWS
 */
export function qualifySystemView(database: string, viewName: string): string {
    return `${database.toUpperCase()}..${viewName}`;
}

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function buildIdentifierCondition(columnExpression: string, identifier: string): string {
    const normalizedIdentifier = unquoteIdentifier(identifier || '');
    const escapedIdentifier = escapeSqlLiteral(normalizedIdentifier);
    const useExactCase = isQuotedIdentifier(identifier) || requiresIdentifierQuoting(normalizedIdentifier);

    if (useExactCase) {
        return `${columnExpression} = '${escapedIdentifier}'`;
    }

    return `UPPER(${columnExpression}) = '${escapedIdentifier.toUpperCase()}'`;
}

// =============================================================================
// COMMON QUERY TEMPLATES
// =============================================================================

/**
 * Query templates for common operations.
 * Use these with string interpolation for database/schema/table names.
 */
export const NZ_QUERIES = {
    /**
     * Get all databases
     * Returns: DATABASE column
     */
    LIST_DATABASES: `
        SELECT DATABASE 
        FROM ${NZ_SYSTEM_VIEWS.DATABASE}
        ORDER BY DATABASE
    `.trim(),

    /**
     * Get schemas in a database
     * @param database - Database name
     */
    listSchemas: (database: string): string => `
        SELECT SCHEMA 
        FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.SCHEMA)} 
        ORDER BY SCHEMA
    `.trim(),

    listTypeGroups: (database: string): string => {
        const db = database.toUpperCase();
        return `
            SELECT DISTINCT OBJTYPE
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.OBJECT_DATA)}
            WHERE DBNAME = '${db}'
            ORDER BY OBJTYPE
        `.trim();
    },

    /**
     * Get all tables and views with metadata from a database
     * Returns: OBJNAME, OBJID, SCHEMA, DBNAME, OBJTYPE, OWNER, DESCRIPTION
     * 
     * IMPORTANT: When database is specified, adds DBNAME filter to ensure proper DESCRIPTION values.
     * When database is NOT specified (global query), DESCRIPTION will be empty for most objects!
     * 
     * @param database - Database name (optional, if not provided uses global view - descriptions will be empty!)
     */
    /**
     * Get all tables and views with metadata from a list of databases
     * @param databases - Array of database names (REQUIRED, must be non-empty)
     * Generates a UNION ALL of per-database `_V_OBJECT_DATA` queries
     */
    listTablesAndViews: (databases: string[]): string => {
        const objTypes = NZ_PREFETCH_CATALOG_OBJECT_TYPES
            .map((type) => `'${type}'`)
            .join(', ');

        if (!Array.isArray(databases) || databases.length === 0) {
            throw new Error("NZ_QUERIES.listTablesAndViews requires a non-empty array of databases.");
        }

        const parts = databases
            .map(d => d && d.trim())
            .filter(Boolean)
            .map(d => d!.toUpperCase())
            .map(db => `
                SELECT
                    O.OBJNAME,
                    O.OBJID,
                    O.SCHEMA,
                    O.DBNAME,
                    O.OBJTYPE,
                    O.OWNER,
                    COALESCE(S.REFOBJNAME, '') AS REFOBJNAME,
                    COALESCE(O.DESCRIPTION, '') AS DESCRIPTION
                FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.OBJECT_DATA)} O
                LEFT JOIN ${qualifySystemView(db, NZ_SYSTEM_VIEWS.SYNONYM)} S ON S.OBJID = O.OBJID
                WHERE O.DBNAME = '${db}' AND O.OBJTYPE IN (${objTypes})
            `.trim());

        if (parts.length === 0) {
            throw new Error("NZ_QUERIES.listTablesAndViews requires a non-empty array of databases.");
        }

        const unionSql = parts.join('\nUNION ALL\n');
        return `
            SELECT * FROM (
${unionSql}
            ) TMP
            ORDER BY DBNAME, SCHEMA, OBJNAME
        `.trim();
    },

    /**
     * Get column metadata for tables in a database with optional PK/FK info
     * Returns: TABLENAME, SCHEMA, ATTNAME, FORMAT_TYPE, ATTNUM, DESCRIPTION, IS_PK, IS_FK
     * 
     * Note: Uses DBNAME filter to ensure we only get objects from the specified database.
     * Column DESCRIPTION comes from _V_RELATION_COLUMN which doesn't have the cross-DB issue.
     * 
     * @param database - Database name
     * @param options - Optional filters: schema, tableName
     */
    listColumnsWithKeys: (database: string, options?: { schema?: string; tableName?: string; objTypes?: string[] }): string => {
        const db = database.toUpperCase();
        const objTypes = options?.objTypes || [NZ_OBJECT_TYPES.TABLE, NZ_OBJECT_TYPES.VIEW, NZ_OBJECT_TYPES.EXTERNAL_TABLE];
        const objTypesStr = objTypes.map(t => `'${t}'`).join(', ');

        // Always filter by DBNAME to ensure we get proper data from this database only
        let whereClause = `O.DBNAME = '${db}' AND O.OBJTYPE IN (${objTypesStr})`;
        if (options?.schema) {
            whereClause += ` AND ${buildIdentifierCondition('O.SCHEMA', options.schema)}`;
        }
        if (options?.tableName) {
            whereClause += ` AND ${buildIdentifierCondition('O.OBJNAME', options.tableName)}`;
        }

        return `
            SELECT 
                O.OBJNAME AS TABLENAME,
                O.SCHEMA,
                O.DBNAME,
                C.ATTNAME,
                C.FORMAT_TYPE,
                C.ATTNUM,
                COALESCE(C.DESCRIPTION, '') AS DESCRIPTION,
                MAX(CASE WHEN K.CONTYPE = '${NZ_CONSTRAINT_TYPES.PRIMARY_KEY}' THEN 1 ELSE 0 END) AS IS_PK,
                MAX(CASE WHEN K.CONTYPE = '${NZ_CONSTRAINT_TYPES.FOREIGN_KEY}' THEN 1 ELSE 0 END) AS IS_FK,
                MAX(CASE WHEN D.ATTNAME IS NOT NULL THEN 1 ELSE 0 END) AS IS_DISTRIBUTION_KEY
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.RELATION_COLUMN)} C
            JOIN ${qualifySystemView(db, NZ_SYSTEM_VIEWS.OBJECT_DATA)} O ON C.OBJID = O.OBJID
            LEFT JOIN ${qualifySystemView(db, NZ_SYSTEM_VIEWS.RELATION_KEYDATA)} K 
                ON K.OBJID = O.OBJID
                AND K.ATTNAME = C.ATTNAME
                AND K.CONTYPE IN ('${NZ_CONSTRAINT_TYPES.PRIMARY_KEY}', '${NZ_CONSTRAINT_TYPES.FOREIGN_KEY}')
            LEFT JOIN ${qualifySystemView(db, NZ_SYSTEM_VIEWS.TABLE_DIST_MAP)} D
                ON D.OBJID = O.OBJID
                AND D.ATTNAME = C.ATTNAME
            WHERE ${whereClause}
            GROUP BY O.OBJNAME, O.SCHEMA, O.DBNAME, C.ATTNAME, C.FORMAT_TYPE, C.ATTNUM, C.DESCRIPTION
            ORDER BY O.SCHEMA, O.OBJNAME, C.ATTNUM
        `.trim();
    },

    /**
     * Get basic column information for a specific table
     * Returns: OBJID, ATTNAME, DESCRIPTION, FULL_TYPE, ATTNOTNULL, COLDEFAULT
     * @param database - Database name
     * @param schema - Schema name
     * @param tableName - Table name
     */
    getTableColumns: (database: string, schema: string, tableName: string): string => {
        const db = database.toUpperCase();
        const schemaFilter = buildIdentifierCondition('D.SCHEMA', schema);
        const tableFilter = buildIdentifierCondition('D.OBJNAME', tableName);
        return `
            SELECT 
                X.OBJID::INT AS OBJID,
                X.ATTNAME,
                X.DESCRIPTION,
                X.FORMAT_TYPE AS FULL_TYPE,
                X.ATTNOTNULL::BOOL AS ATTNOTNULL,
                X.COLDEFAULT
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.RELATION_COLUMN)} X
            INNER JOIN ${qualifySystemView(db, NZ_SYSTEM_VIEWS.OBJECT_DATA)} D ON X.OBJID = D.OBJID
            WHERE X.TYPE IN ('${NZ_OBJECT_TYPES.TABLE}','${NZ_OBJECT_TYPES.VIEW}','${NZ_OBJECT_TYPES.EXTERNAL_TABLE}','${NZ_OBJECT_TYPES.SEQUENCE}','${NZ_OBJECT_TYPES.SYSTEM_VIEW}','${NZ_OBJECT_TYPES.SYSTEM_TABLE}')
                AND X.OBJID NOT IN (4,5)
                AND ${schemaFilter}
                AND ${tableFilter}
            ORDER BY X.OBJID, X.ATTNUM
        `.trim();
    },

    /**
     * Get distribution key columns for a table
     * Returns: ATTNAME
     * @param database - Database name
     * @param schema - Schema name
     * @param tableName - Table name
     */
    getDistributionKeys: (database: string, schema: string, tableName: string): string => {
        const db = database.toUpperCase();
        const schemaFilter = buildIdentifierCondition('SCHEMA', schema);
        const tableFilter = buildIdentifierCondition('TABLENAME', tableName);
        return `
            SELECT ATTNAME
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.TABLE_DIST_MAP)}
            WHERE ${schemaFilter}
                AND ${tableFilter}
            ORDER BY DISTSEQNO
        `.trim();
    },

    /**
     * Get organization/clustering columns for a table
     * Returns: ATTNAME
     * @param database - Database name
     * @param schema - Schema name
     * @param tableName - Table name
     */
    getOrganizeColumns: (database: string, schema: string, tableName: string): string => {
        const db = database.toUpperCase();
        const schemaFilter = buildIdentifierCondition('SCHEMA', schema);
        const tableFilter = buildIdentifierCondition('TABLENAME', tableName);
        return `
            SELECT ATTNAME
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.TABLE_ORGANIZE_COLUMN)}
            WHERE ${schemaFilter}
                AND ${tableFilter}
            ORDER BY ORGSEQNO
        `.trim();
    },

    /**
     * Get key constraints (PK, FK, UNIQUE) for a table
     * Returns: CONSTRAINTNAME, CONTYPE, ATTNAME, PK* columns for FK references
     * @param database - Database name
     * @param schema - Schema name
     * @param tableName - Table name
     */
    getTableKeys: (database: string, schema: string, tableName: string): string => {
        const db = database.toUpperCase();
        const schemaFilter = buildIdentifierCondition('X.SCHEMA', schema);
        const tableFilter = buildIdentifierCondition('X.RELATION', tableName);
        return `
            SELECT 
                X.SCHEMA,
                X.RELATION,
                X.CONSTRAINTNAME,
                X.CONTYPE,
                X.ATTNAME,
                X.PKDATABASE,
                X.PKSCHEMA,
                X.PKRELATION,
                X.PKATTNAME,
                X.UPDT_TYPE,
                X.DEL_TYPE
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.RELATION_KEYDATA)} X
            WHERE X.OBJID NOT IN (4,5)
                AND ${schemaFilter}
                AND ${tableFilter}
            ORDER BY X.SCHEMA, X.RELATION, X.CONSEQ
        `.trim();
    },

    /**
     * Get foreign key relationships for a schema (for ERD diagrams)
     * Returns: FK constraint details with source and target table/column info
     * @param database - Database name
     * @param schema - Schema name
     */
    getForeignKeyRelationships: (database: string, schema: string): string => {
        const db = database.toUpperCase();
        const schemaFilter = buildIdentifierCondition('X.SCHEMA', schema);
        return `
            SELECT 
                X.SCHEMA,
                X.RELATION AS FROM_TABLE,
                X.CONSTRAINTNAME,
                X.ATTNAME AS FROM_COLUMN,
                X.PKDATABASE,
                X.PKSCHEMA,
                X.PKRELATION AS TO_TABLE,
                X.PKATTNAME AS TO_COLUMN,
                X.UPDT_TYPE,
                X.DEL_TYPE,
                X.CONSEQ
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.RELATION_KEYDATA)} X
            WHERE X.CONTYPE = '${NZ_CONSTRAINT_TYPES.FOREIGN_KEY}'
                AND ${schemaFilter}
            ORDER BY X.CONSTRAINTNAME, X.CONSEQ
        `.trim();
    },

    /**
     * Get table/object comment (DESCRIPTION)
     * 
     * IMPORTANT: Uses DBNAME filter to ensure proper DESCRIPTION value.
     * Without DBNAME filter, DESCRIPTION would be empty for objects from other databases.
     * 
     * @param database - Database name
     * @param schema - Schema name
     * @param objectName - Object name
     * @param objectType - Optional object type filter
     */
    getObjectComment: (database: string, schema: string, objectName: string, objectType?: string): string => {
        const db = database.toUpperCase();
        const typeFilter = objectType ? ` AND OBJTYPE = '${objectType}'` : '';
        const schemaFilter = buildIdentifierCondition('SCHEMA', schema);
        const objectFilter = buildIdentifierCondition('OBJNAME', objectName);
        return `
            SELECT DESCRIPTION
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.OBJECT_DATA)}
            WHERE DBNAME = '${db}'
                AND ${schemaFilter}
                AND ${objectFilter}${typeFilter}
        `.trim();
    },

    /**
     * Get table owner
     * Returns: OWNER
     * @param database - Database name
     * @param schema - Schema name
     * @param tableName - Table name
     */
    getTableOwner: (database: string, schema: string, tableName: string): string => {
        const db = database.toUpperCase();
        const schemaFilter = buildIdentifierCondition('SCHEMA', schema);
        const tableFilter = buildIdentifierCondition('TABLENAME', tableName);
        return `
            SELECT OWNER
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.TABLE)}
            WHERE ${schemaFilter}
                AND ${tableFilter}
        `.trim();
    },

    /**
     * Get view definition
     * Returns: SCHEMA, VIEWNAME, DEFINITION, OWNER
     * 
     * ⚠️ CRITICAL: The DEFINITION column will ONLY contain the view's SQL source
     * if the DATABASE connection is established to the SAME database where the view exists!
     * Simply using DATABASE.._V_VIEW is NOT sufficient - you must be CONNECTED to DATABASE.
     * 
     * If connected to a different database, DEFINITION will be NULL/empty.
     * 
     * @param database - Database name (connection must be to this database for DEFINITION to work)
     * @param viewName - View name
     * @param schema - Optional schema name
     */
    getViewDefinition: (database: string, viewName: string, schema?: string): string => {
        const db = database.toUpperCase();
        let whereClause = buildIdentifierCondition('VIEWNAME', viewName);
        if (schema) {
            whereClause += ` AND ${buildIdentifierCondition('SCHEMA', schema)}`;
        }
        return `
            SELECT SCHEMA, VIEWNAME, DEFINITION, OWNER
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.VIEW)}
            WHERE ${whereClause}
        `.trim();
    },

    /**
     * Get procedure definition
     * Returns: SCHEMA, PROCEDURE, PROCEDURESIGNATURE, PROCEDURESOURCE, RETURNS, OWNER
     * 
     * NOTE: Unlike _V_VIEW.DEFINITION, the PROCEDURESOURCE column is accessible
     * cross-database - no need to connect to the specific database.
     * 
     * @param database - Database name
     * @param procedureName - Procedure name
     * @param schema - Optional schema name
     */
    getProcedureDefinition: (database: string, procedureName: string, schema?: string): string => {
        const db = database.toUpperCase();
        let whereClause = buildIdentifierCondition('PROCEDURE', procedureName);
        if (schema) {
            whereClause += ` AND ${buildIdentifierCondition('SCHEMA', schema)}`;
        }
        return `
            SELECT SCHEMA, PROCEDURE, PROCEDURESIGNATURE, PROCEDURESOURCE, 
                   RESULT AS RETURNS, OWNER
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.PROCEDURE)}
            WHERE ${whereClause}
        `.trim();
    },

    /**
     * List procedures in a database
     * Returns: SCHEMA, PROCEDURE, PROCEDURESIGNATURE, RESULT, OWNER
     * @param database - Optional database name (if not provided, searches all)
     * @param schema - Optional schema filter
     */
    listProcedures: (database?: string, schema?: string): string => {
        if (database) {
            let whereClause = `DATABASE = '${database.toUpperCase()}'`;
            if (schema) {
                whereClause += ` AND ${buildIdentifierCondition('SCHEMA', schema)}`;
            }
            return `
                SELECT SCHEMA, PROCEDURE, PROCEDURESIGNATURE, RESULT AS RETURNS, OWNER, DATABASE
                FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.PROCEDURE)}
                WHERE ${whereClause}
                ORDER BY SCHEMA, PROCEDURE
            `.trim();
        }
        // Search all databases - not directly supported, caller should iterate
        return '';
    },

    /**
     * List views in a database
     * Returns: SCHEMA, VIEWNAME, OWNER
     * @param database - Optional database name
     * @param schema - Optional schema filter
     */
    listViews: (database?: string, schema?: string): string => {
        if (database) {
            let whereClause = '1=1';
            if (schema) {
                whereClause = buildIdentifierCondition('SCHEMA', schema);
            }
            return `
                SELECT SCHEMA, VIEWNAME, OWNER, '${database}' AS DATABASE
                FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.VIEW)}
                WHERE ${whereClause}
                ORDER BY SCHEMA, VIEWNAME
            `.trim();
        }
        return '';
    },

    /**
     * Get external table metadata
     * Returns: External table details with data object info
     * @param database - Database name
     * @param schema - Optional schema filter
     */
    getExternalTables: (database: string, schema?: string): string => {
        const db = database.toUpperCase();
        let whereClause = '1=1';
        if (schema) {
            whereClause = buildIdentifierCondition('E1.SCHEMA', schema);
        }
        return `
            SELECT 
                E1.TABLENAME,
                E1.SCHEMA,
                E2.OWNER,
                E1.DATABASE,
                E2.EXTOBJNAME AS DATAOBJECT
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.EXTERNAL)} E1
            LEFT JOIN ${qualifySystemView(db, NZ_SYSTEM_VIEWS.EXTOBJECT)} E2 
                ON E1.RELID = E2.OBJID
            WHERE ${whereClause}
            ORDER BY E1.SCHEMA, E1.TABLENAME
        `.trim();
    },

    /**
     * Find schema for a table in a database
     * Returns: SCHEMA
     * 
     * Uses DBNAME filter to search only in the specified database.
     * 
     * @param database - Database name
     * @param tableName - Table name
     */
    findTableSchema: (database: string, tableName: string): string => {
        const db = database.toUpperCase();
        const tableFilter = buildIdentifierCondition('OBJNAME', tableName);
        return `
            SELECT SCHEMA
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.OBJECT_DATA)}
            WHERE DBNAME = '${db}'
                AND ${tableFilter}
                AND OBJTYPE IN ('${NZ_OBJECT_TYPES.TABLE}', '${NZ_OBJECT_TYPES.VIEW}', '${NZ_OBJECT_TYPES.EXTERNAL_TABLE}')
            LIMIT 1
        `.trim();
    },

    /**
     * Search for tables/views by name pattern
     * @param database - Database name (optional, if not provided uses global view)
     * @param pattern - Search pattern (use % for wildcards)
     */
    searchTables: (pattern: string, database?: string): string => {
        const objTypes = `'${NZ_OBJECT_TYPES.TABLE}', '${NZ_OBJECT_TYPES.VIEW}', '${NZ_OBJECT_TYPES.MATERIALIZED_VIEW}', '${NZ_OBJECT_TYPES.EXTERNAL_TABLE}'`;

        if (database) {
            return `
                SELECT '${database}' AS DATABASE, SCHEMA, TABLENAME, 
                    CASE RELKIND WHEN 'r' THEN '${NZ_OBJECT_TYPES.TABLE}' WHEN 'v' THEN '${NZ_OBJECT_TYPES.VIEW}' ELSE RELKIND END AS TYPE
                FROM ${qualifySystemView(database, NZ_SYSTEM_VIEWS.TABLE)}
                WHERE UPPER(TABLENAME) LIKE '${pattern.toUpperCase()}'
                ORDER BY SCHEMA, TABLENAME
                LIMIT 1000
            `.trim();
        }
        // Global search
        return `
            SELECT DBNAME AS DATABASE, SCHEMA, OBJNAME AS TABLENAME, 
                CASE OBJTYPE WHEN '${NZ_OBJECT_TYPES.TABLE}' THEN '${NZ_OBJECT_TYPES.TABLE}' 
                     WHEN '${NZ_OBJECT_TYPES.VIEW}' THEN '${NZ_OBJECT_TYPES.VIEW}' 
                     WHEN '${NZ_OBJECT_TYPES.MATERIALIZED_VIEW}' THEN 'MVIEW' 
                     WHEN '${NZ_OBJECT_TYPES.EXTERNAL_TABLE}' THEN 'EXTERNAL' 
                     ELSE OBJTYPE END AS TYPE
            FROM ${NZ_SYSTEM_VIEWS.OBJECT_DATA}
            WHERE UPPER(OBJNAME) LIKE '${pattern.toUpperCase()}'
                AND OBJTYPE IN (${objTypes})
            ORDER BY DBNAME, SCHEMA, OBJNAME
            LIMIT 1000
        `.trim();
    },

    /**
     * Search for columns by name pattern
     * @param database - Database name
     * @param pattern - Search pattern (use % for wildcards)
     */
    searchColumns: (database: string, pattern: string): string => {
        const db = database.toUpperCase();
        return `
            SELECT '${database}' AS DATABASE, t.SCHEMA, t.TABLENAME, c.ATTNAME AS COLUMN_NAME, c.FORMAT_TYPE AS DATA_TYPE
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.TABLE)} t
            JOIN ${qualifySystemView(db, NZ_SYSTEM_VIEWS.RELATION_COLUMN)} c ON t.OBJID = c.OBJID
            WHERE UPPER(c.ATTNAME) LIKE '${pattern.toUpperCase()}'
            ORDER BY t.SCHEMA, t.TABLENAME, c.ATTNAME
            LIMIT 1000
        `.trim();
    },

    /**
     * Get table stats info (for distribution/owner)
     * @param database - Database name
     * @param schema - Schema name
     * @param tableName - Table name
     */
    getTableStats: (database: string, schema: string, tableName: string): string => {
        const db = database.toUpperCase();
        const schemaFilter = buildIdentifierCondition('t.SCHEMA', schema);
        const tableFilter = buildIdentifierCondition('t.TABLENAME', tableName);
        return `
            SELECT 
                d.ATTNAME AS DIST_KEY,
                t.OWNER
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.TABLE)} t
            LEFT JOIN ${qualifySystemView(db, NZ_SYSTEM_VIEWS.TABLE_DIST_MAP)} d ON t.OBJID = d.OBJID
            WHERE ${schemaFilter} AND ${tableFilter}
        `.trim();
    },

    /**
     * Find views that depend on an object by searching in their DEFINITION
     * 
     * ⚠️ WARNING: The DEFINITION column is only populated when connected to the database
     * containing the views. If connected to a different database, this query will find nothing
     * because DEFINITION will be NULL/empty. Ensure the connection is to the correct database.
     * 
     * @param database - Database name (connection must be to this database)
     * @param objectName - Object name to search for in view definitions
     */
    findDependentViews: (database: string, objectName: string): string => {
        const db = database.toUpperCase();
        return `
            SELECT v.SCHEMA, v.VIEWNAME, v.OWNER
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.VIEW)} v
            WHERE UPPER(v.DEFINITION) LIKE '%${objectName.toUpperCase()}%'
                AND v.VIEWNAME != '${objectName.toUpperCase()}'
            ORDER BY v.SCHEMA, v.VIEWNAME
            LIMIT 50
        `.trim();
    },

    /**
     * Find procedures that reference an object by searching in their PROCEDURESOURCE
     * 
     * NOTE: Unlike _V_VIEW.DEFINITION, PROCEDURESOURCE is accessible cross-database.
     * 
     * @param database - Database name
     * @param objectName - Object name to search for in procedure source
     */
    findDependentProcedures: (database: string, objectName: string): string => {
        const db = database.toUpperCase();
        return `
            SELECT SCHEMA, PROCEDURE AS PROC_NAME, OWNER
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.PROCEDURE)}
            WHERE UPPER(PROCEDURESOURCE) LIKE '%${objectName.toUpperCase()}%'
            ORDER BY SCHEMA, PROCEDURE
            LIMIT 25
        `.trim();
    },

    /**
     * Get all objects of a type from a database (for DDL batch export)
     * @param database - Database name
     * @param objType - Object type (TABLE, VIEW, etc.)
     * @param schema - Optional schema filter
     */
    listObjectsOfType: (database: string, objType: string, schema?: string): string => {
        const db = database.toUpperCase();

        // Special handling for procedures
        if (objType === NZ_OBJECT_TYPES.PROCEDURE) {
            let query = `SELECT PROCEDURESIGNATURE AS OBJNAME, SCHEMA FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.PROCEDURE)} WHERE DATABASE = '${db}'`;
            if (schema) {
                query += ` AND ${buildIdentifierCondition('SCHEMA', schema)}`;
            }
            return query + ` ORDER BY SCHEMA, PROCEDURESIGNATURE`;
        }

        // All other object types
        let query = `SELECT OBJNAME, SCHEMA FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.OBJECT_DATA)} WHERE DBNAME = '${db}' AND OBJTYPE = '${objType}'`;
        if (schema) {
            query += ` AND ${buildIdentifierCondition('SCHEMA', schema)}`;
        }
        return query + ` ORDER BY SCHEMA, OBJNAME`;
    },

    /**
     * Get distinct object types in a database
     * @param database - Database name
     */
    getObjectTypes: (database: string): string => {
        const db = database.toUpperCase();
        return `
            SELECT DISTINCT OBJTYPE 
            FROM ${qualifySystemView(db, NZ_SYSTEM_VIEWS.OBJECT_DATA)} 
            WHERE DBNAME = '${db}' 
            ORDER BY OBJTYPE
        `.trim();
    },
} as const;
