/**
 * Scheduler Service - MongoDB-Backed Persistent Reminders
 *
 * Uses Agenda for persistent job scheduling with MongoDB storage.
 * Survives Railway restarts and handles distributed execution.
 */

const Agenda = require('agenda');
const { resolveNameToPhone, getUserDisplayName } = require('../database/mongodb');

let agenda = null;
let twilioClient = null;

/**
 * Initialize the scheduler with MongoDB connection
 */
async function initScheduler(mongoUri, twilio) {
  if (!mongoUri) {
    console.warn('⚠️  MongoDB URI not provided - scheduler will not work');
    return null;
  }

  twilioClient = twilio;

  // Create Agenda instance
  agenda = new Agenda({
    db: {
      address: mongoUri,
      collection: 'scheduled_jobs'
    },
    processEvery: '30 seconds', // Check for jobs every 30 seconds
    maxConcurrency: 5,
    defaultConcurrency: 2
  });

  // Define job handlers
  defineJobHandlers();

  // Event handlers
  agenda.on('ready', () => {
    console.log('✅ Scheduler ready (Agenda + MongoDB)');
  });

  agenda.on('error', (error) => {
    console.error('❌ Scheduler error:', error);
  });

  agenda.on('start', (job) => {
    console.log(`🕐 Job started: ${job.attrs.name} (${job.attrs.data.description || 'no description'})`);
  });

  agenda.on('complete', (job) => {
    console.log(`✅ Job completed: ${job.attrs.name}`);
  });

  agenda.on('fail', (error, job) => {
    console.error(`❌ Job failed: ${job.attrs.name}`, error);
  });

  // Start the scheduler
  await agenda.start();
  console.log('🚀 Scheduler started');

  return agenda;
}

/**
 * Define job handlers
 */
function defineJobHandlers() {
  // Handler: Send WhatsApp Reminder
  agenda.define('send_reminder', async (job) => {
    const { description, recipients, originalRequester } = job.attrs.data;

    console.log(`📨 Sending reminder: "${description}" to ${recipients.length} recipient(s)`);

    if (!twilioClient) {
      throw new Error('Twilio client not initialized');
    }

    const message = `⏰ *Recordatorio*\n\n${description}`;

    // Send to all recipients
    for (const recipientPhone of recipients) {
      try {
        // Format phone number for WhatsApp
        const whatsappNumber = recipientPhone.startsWith('whatsapp:')
          ? recipientPhone
          : `whatsapp:${recipientPhone}`;

        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: whatsappNumber,
          body: message
        });

        console.log(`  ✅ Sent to ${recipientPhone}`);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`  ❌ Failed to send to ${recipientPhone}:`, error.message);
      }
    }

    console.log(`✅ Reminder sent to all recipients`);
  });
}

/**
 * Schedule a reminder
 * @param {Date|string} when - When to send (Date object or ISO string)
 * @param {Array<string>} recipientNames - Names or phone numbers
 * @param {string} description - Reminder message
 * @param {string} requesterPhone - Who scheduled it
 * @returns {Promise<Object>} - Job info
 */
async function scheduleReminder(when, recipientNames, description, requesterPhone) {
  if (!agenda) {
    throw new Error('Scheduler not initialized');
  }

  // Resolve recipient names to phone numbers
  const recipientPhones = [];
  const failedResolutions = [];

  for (const name of recipientNames) {
    // Check if it's already a phone number
    if (name.match(/^\+?\d{10,15}$/)) {
      recipientPhones.push(name);
      continue;
    }

    // Special case: "me" or "yo" = requester
    if (name.toLowerCase() === 'me' || name.toLowerCase() === 'yo') {
      recipientPhones.push(requesterPhone);
      continue;
    }

    // Resolve name
    const phone = await resolveNameToPhone(name);
    if (phone) {
      recipientPhones.push(phone);
    } else {
      failedResolutions.push(name);
    }
  }

  if (failedResolutions.length > 0) {
    return {
      success: false,
      error: `Could not find users: ${failedResolutions.join(', ')}`,
      failedNames: failedResolutions
    };
  }

  if (recipientPhones.length === 0) {
    return {
      success: false,
      error: 'No valid recipients found'
    };
  }

  // Parse time if it's a string
  const executionTime = typeof when === 'string' ? new Date(when) : when;

  // Validate time is in the future
  if (executionTime <= new Date()) {
    return {
      success: false,
      error: 'Execution time must be in the future'
    };
  }

  // Create the job
  const job = await agenda.schedule(executionTime, 'send_reminder', {
    description,
    recipients: recipientPhones,
    originalRequester: requesterPhone
  });

  console.log(`📅 Scheduled reminder for ${executionTime.toISOString()}`);
  console.log(`   Recipients: ${recipientPhones.join(', ')}`);
  console.log(`   Message: ${description}`);

  return {
    success: true,
    jobId: job.attrs._id,
    scheduledFor: executionTime.toISOString(),
    recipientCount: recipientPhones.length,
    recipients: recipientPhones,
    description
  };
}

/**
 * Cancel a scheduled reminder
 */
async function cancelReminder(jobId) {
  if (!agenda) {
    throw new Error('Scheduler not initialized');
  }

  const numRemoved = await agenda.cancel({ _id: jobId });

  return {
    success: numRemoved > 0,
    message: numRemoved > 0 ? 'Reminder cancelled' : 'Reminder not found'
  };
}

/**
 * Get upcoming reminders for a user
 */
async function getUpcomingReminders(phoneNumber, limit = 10) {
  if (!agenda) {
    throw new Error('Scheduler not initialized');
  }

  const jobs = await agenda.jobs({
    name: 'send_reminder',
    'data.recipients': phoneNumber,
    nextRunAt: { $ne: null, $gte: new Date() }
  }, { nextRunAt: 1 }, limit);

  return jobs.map(job => ({
    id: job.attrs._id,
    description: job.attrs.data.description,
    scheduledFor: job.attrs.nextRunAt,
    recipientCount: job.attrs.data.recipients.length
  }));
}

/**
 * Graceful shutdown
 */
async function stopScheduler() {
  if (agenda) {
    await agenda.stop();
    console.log('⏹️  Scheduler stopped');
  }
}

module.exports = {
  initScheduler,
  scheduleReminder,
  cancelReminder,
  getUpcomingReminders,
  stopScheduler
};
