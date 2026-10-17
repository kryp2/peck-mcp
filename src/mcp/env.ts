/**
 * Loads ./.env, but not over stdio.
 *
 * dotenv reads .env from the working directory. Over stdio that is whatever
 * project the MCP client was opened in, so a .env committed to a repository
 * could repoint PECK_READER_URL / IDENTITY_URL (and with them the recipient of
 * peck_payment_tx or the key of an encrypted DM). Stdio gets its environment
 * from the MCP client config; a file is read only when DOTENV_CONFIG_PATH names
 * one explicitly.
 *
 * This is a separate module so it runs before the others are evaluated, as
 * `import 'dotenv/config'` did.
 */
import { config } from 'dotenv'
import { shouldLoadDotenv } from './hosted.js'

if (shouldLoadDotenv()) config({ quiet: true })
