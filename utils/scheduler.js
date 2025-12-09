const cron = require('node-cron');

// Store for scheduled jobs
const scheduledJobs = new Map();

/**
 * Schedule a recurring message
 * @param {string} jobId - Unique identifier for the job
 * @param {string} cronExpression - Cron expression (e.g., '0 9 * * *' for 9 AM daily)
 * @param {Function} sendMessageFn - Function to send the message
 * @param {string} phoneNumber - WhatsApp number to send to
 * @param {string} message - Message content
 * @returns {Object} Job info
 */
function scheduleRecurringMessage(jobId, cronExpression, sendMessageFn, phoneNumber, message) {
  // Cancel existing job if it exists
  if (scheduledJobs.has(jobId)) {
    scheduledJobs.get(jobId).stop();
  }

  // Create new scheduled job
  const task = cron.schedule(cronExpression, async () => {
    try {
      console.log(`Executing scheduled job: ${jobId}`);
      await sendMessageFn(phoneNumber, message);
    } catch (error) {
      console.error(`Error in scheduled job ${jobId}:`, error);
    }
  }, {
    scheduled: true,
    timezone: "America/Santo_Domingo" // Dominican Republic timezone
  });

  scheduledJobs.set(jobId, task);

  console.log(`Scheduled recurring message: ${jobId} with cron ${cronExpression}`);

  return {
    jobId,
    cronExpression,
    phoneNumber,
    message: message.substring(0, 50) + '...',
    status: 'active'
  };
}

/**
 * Schedule a one-time message
 * @param {string} jobId - Unique identifier for the job
 * @param {Date} sendAt - When to send the message
 * @param {Function} sendMessageFn - Function to send the message
 * @param {string} phoneNumber - WhatsApp number to send to
 * @param {string} message - Message content
 * @returns {Object} Job info
 */
function scheduleOneTimeMessage(jobId, sendAt, sendMessageFn, phoneNumber, message) {
  const now = new Date();
  const delay = sendAt.getTime() - now.getTime();

  if (delay <= 0) {
    throw new Error('Scheduled time must be in the future');
  }

  // Cancel existing job if it exists
  if (scheduledJobs.has(jobId)) {
    clearTimeout(scheduledJobs.get(jobId));
  }

  const timeoutId = setTimeout(async () => {
    try {
      console.log(`Executing one-time job: ${jobId}`);
      await sendMessageFn(phoneNumber, message);
      scheduledJobs.delete(jobId);
    } catch (error) {
      console.error(`Error in one-time job ${jobId}:`, error);
    }
  }, delay);

  scheduledJobs.set(jobId, timeoutId);

  console.log(`Scheduled one-time message: ${jobId} for ${sendAt.toISOString()}`);

  return {
    jobId,
    sendAt: sendAt.toISOString(),
    phoneNumber,
    message: message.substring(0, 50) + '...',
    status: 'scheduled'
  };
}

/**
 * Cancel a scheduled job
 * @param {string} jobId - ID of the job to cancel
 * @returns {boolean} Success status
 */
function cancelScheduledMessage(jobId) {
  if (!scheduledJobs.has(jobId)) {
    return false;
  }

  const job = scheduledJobs.get(jobId);

  // Check if it's a cron job or timeout
  if (job.stop && typeof job.stop === 'function') {
    job.stop();
  } else {
    clearTimeout(job);
  }

  scheduledJobs.delete(jobId);
  console.log(`Cancelled scheduled message: ${jobId}`);

  return true;
}

/**
 * List all scheduled jobs
 * @returns {Array} List of scheduled jobs
 */
function listScheduledMessages() {
  const jobs = [];

  for (const [jobId, job] of scheduledJobs.entries()) {
    jobs.push({
      jobId,
      type: job.stop ? 'recurring' : 'one-time',
      status: 'active'
    });
  }

  return jobs;
}

module.exports = {
  scheduleRecurringMessage,
  scheduleOneTimeMessage,
  cancelScheduledMessage,
  listScheduledMessages
};
