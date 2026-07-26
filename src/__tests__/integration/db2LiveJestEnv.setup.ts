/**
 * Jest live config: load bundled clidriver into the test process (no system ODBC changes).
 */
import { configureBundledClidriverForCurrentProcess } from '../../../extensions/db2/src/db2Connection';

configureBundledClidriverForCurrentProcess();
