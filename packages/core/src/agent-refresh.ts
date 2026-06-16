/**
 * Postgres LISTEN/NOTIFY channel used to propagate agent enable/disable/
 * schedule changes from the web (api) process to the worker process that
 * hosts the scheduler.
 *
 * The api process writes the settings row, then `pg_notify(channel, slug)`.
 * The worker's scheduler LISTENs on this channel and calls `refreshAgent(slug)`
 * so the change takes effect live, without a worker restart.
 *
 * Payload is always the agent slug.
 */
export const AGENT_REFRESH_CHANNEL = 'bos_agent_refresh';
