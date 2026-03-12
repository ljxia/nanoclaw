import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Route uncaught errors through pino so they get timestamps in stderr.
// Network-related errors should not crash the process — channels handle
// their own reconnection. Only exit for truly fatal errors.
process.on('uncaughtException', (err) => {
  const msg = err?.message || '';
  const isNetworkError =
    /ECONNRE|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|socket hang up|network/i.test(
      msg,
    );
  if (isNetworkError) {
    logger.error({ err }, 'Network error (non-fatal, not crashing)');
  } else {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
