/**
 * Seed & Launch Script - Version 2.0 Announcement
 *
 * This script performs two critical actions:
 * 1. Seeds/Updates the User profiles in MongoDB
 * 2. Sends the V2.0 launch announcement via WhatsApp
 *
 * Usage: node scripts/seedAndLaunch.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const twilio = require('twilio');
const User = require('../models/User');

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Master User List
const USERS = [
  {
    phone: '+18096510177',
    alias: 'Sr. Max',
    name: 'Max Alejandro Mejia Gonzalez',
    email: 'mxmejia13@gmail.com'
  },
  {
    phone: '+18098903565',
    alias: 'Sr. Vinicio',
    name: 'Vinicio Alfredo Mejia Gonzalez',
    email: 'viniciomejia5@gmail.com'
  },
  {
    phone: '+18293803443',
    alias: 'Sr. Sebastian',
    name: 'Sebastian Andres Mejia Gonzalez',
    email: 'sebastianandresmejiagonzalez@gmail.com'
  },
  {
    phone: '+18093833443',
    alias: 'Sr. Pally',
    name: 'Vinicio Alfredo Mejia Medina',
    email: 'viniciomejia@yahoo.com'
  },
  {
    phone: '+18292995088',
    alias: 'Sr. Jose',
    name: 'Jose Ismael Medina Reyes',
    email: '' // No email provided
  }
];

/**
 * Generate V2.0 Launch WhatsApp Message
 */
function generateWelcomeMessage(user) {
  const displayName = user.alias || user.name.split(' ')[0];

  return `🚀 *¡ACTUALIZACIÓN V2.0 DISPONIBLE!*

Hola ${displayName}, tu Asistente Contable ha evolucionado.

*🎯 5 NUEVAS HERRAMIENTAS:*

*1. 🔒 Privacidad Total*
Tus archivos ahora son 100% privados. Solo tú decides quién puede verlos.

*2. 🧠 Búsqueda Natural*
Ya no necesitas comandos exactos. Prueba:
_"Búscame la factura de La Sirena de la semana pasada"_

*3. 📧 Bóveda de Correo*
Reenvía facturas a:
*bot@mejiafamily.app*
El bot las guardará automáticamente.

*4. 📊 Reportes Instantáneos*
Pide: _"Mándame un reporte de todas las facturas de Noviembre"_

*5. ⏰ Agenda Inteligente*
Escribe: _"Recuérdame pagar la tarjeta mañana a las 9 AM"_

━━━━━━━━━━━━━━━━━━━━━━━
*¿CÓMO EMPEZAR?*
Envía una foto de una factura o escribe *"Ayuda"* para ver todas las funciones.

_El Equipo de Saldeso_ ✨`.trim();
}

/**
 * Upsert user in MongoDB
 */
async function upsertUser(userData) {
  try {
    const userDoc = {
      phoneNumber: userData.phone,
      alias: userData.alias,
      fullName: userData.name,
      email: userData.email || '',
      // Legacy compatibility
      title: userData.alias,
      name: userData.name
    };

    // Remove empty email to avoid validation issues
    if (!userDoc.email) {
      delete userDoc.email;
    }

    const user = await User.findOneAndUpdate(
      { phoneNumber: userData.phone },
      {
        $set: userDoc,
        $setOnInsert: {
          createdAt: new Date(),
          totalFiles: 0,
          totalMessages: 0,
          preferences: {}
        }
      },
      {
        upsert: true,
        new: true,
        runValidators: true
      }
    );

    console.log(`✅ Upserted: ${user.alias} (${user.phoneNumber})`);
    return { success: true, user };
  } catch (error) {
    console.error(`❌ Failed to upsert ${userData.phone}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send WhatsApp message via Twilio
 */
async function sendWhatsAppMessage(phoneNumber, message, alias) {
  try {
    // Format phone number for Twilio (add whatsapp: prefix)
    const to = phoneNumber.startsWith('whatsapp:')
      ? phoneNumber
      : `whatsapp:${phoneNumber}`;

    const result = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
      body: message
    });

    console.log(`✅ WhatsApp sent to ${alias}: ${result.sid}`);
    return { success: true, sid: result.sid };
  } catch (error) {
    console.error(`❌ Failed to send WhatsApp to ${alias}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Mark user as notified for V2.0
 */
async function markV2Notified(phoneNumber) {
  try {
    await User.findOneAndUpdate(
      { phoneNumber },
      {
        $set: {
          v2LaunchNotified: true,
          v2LaunchNotifiedAt: new Date()
        }
      }
    );
  } catch (error) {
    console.error(`⚠️  Failed to mark V2 notification for ${phoneNumber}`);
  }
}

/**
 * Main execution function
 */
async function seedAndLaunch() {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 SEED & LAUNCH: Version 2.0 User Setup + WhatsApp Announcement');
  console.log('='.repeat(70) + '\n');

  const stats = {
    totalUsers: USERS.length,
    upsertSuccess: 0,
    upsertFailed: 0,
    whatsappSuccess: 0,
    whatsappFailed: 0,
    errors: []
  };

  try {
    // 1. Connect to MongoDB
    console.log('📡 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // 2. Validate Twilio credentials
    console.log('📱 Validating Twilio credentials...');
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('Missing Twilio credentials in .env');
    }
    if (!process.env.TWILIO_WHATSAPP_NUMBER) {
      throw new Error('Missing TWILIO_WHATSAPP_NUMBER in .env');
    }
    console.log('✅ Twilio credentials validated\n');

    // 3. Process each user
    console.log('👥 Processing users...\n');
    console.log('-'.repeat(70));

    for (let i = 0; i < USERS.length; i++) {
      const userData = USERS[i];
      const userLabel = `[${i + 1}/${USERS.length}]`;

      console.log(`\n${userLabel} ${userData.alias} (${userData.phone})`);

      // Action A: Upsert user in MongoDB
      console.log(`   📝 Upserting in database...`);
      const upsertResult = await upsertUser(userData);

      if (upsertResult.success) {
        stats.upsertSuccess++;
      } else {
        stats.upsertFailed++;
        stats.errors.push({
          user: userData.alias,
          action: 'upsert',
          error: upsertResult.error
        });
        console.log(`   ⚠️  Skipping WhatsApp notification due to upsert failure`);
        continue; // Skip WhatsApp if upsert failed
      }

      // Action B: Send WhatsApp announcement
      console.log(`   📱 Sending WhatsApp announcement...`);
      const message = generateWelcomeMessage(userData);
      const whatsappResult = await sendWhatsAppMessage(
        userData.phone,
        message,
        userData.alias
      );

      if (whatsappResult.success) {
        stats.whatsappSuccess++;
        // Mark user as notified
        await markV2Notified(userData.phone);
      } else {
        stats.whatsappFailed++;
        stats.errors.push({
          user: userData.alias,
          action: 'whatsapp',
          error: whatsappResult.error
        });
      }

      // Rate limiting: 2 seconds between users
      if (i < USERS.length - 1) {
        console.log(`   ⏳ Waiting 2 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // 4. Summary
    console.log('\n' + '='.repeat(70));
    console.log('📊 EXECUTION SUMMARY');
    console.log('='.repeat(70));
    console.log(`Total users processed: ${stats.totalUsers}\n`);

    console.log('📝 Database Upserts:');
    console.log(`   ✅ Successful: ${stats.upsertSuccess}`);
    console.log(`   ❌ Failed: ${stats.upsertFailed}\n`);

    console.log('📱 WhatsApp Announcements:');
    console.log(`   ✅ Successful: ${stats.whatsappSuccess}`);
    console.log(`   ❌ Failed: ${stats.whatsappFailed}`);

    if (stats.errors.length > 0) {
      console.log('\n❌ Errors:');
      stats.errors.forEach((err, idx) => {
        console.log(`   ${idx + 1}. ${err.user} (${err.action}): ${err.error}`);
      });
    }

    console.log('\n' + '='.repeat(70));

    if (stats.upsertFailed === 0 && stats.whatsappFailed === 0) {
      console.log('✅ ALL OPERATIONS SUCCESSFUL!');
    } else {
      console.log('⚠️  Some operations failed. Review errors above.');
    }

    console.log('='.repeat(70) + '\n');

  } catch (error) {
    console.error('\n💥 FATAL ERROR:', error.message);
    console.error(error.stack);
    throw error;
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('📡 MongoDB connection closed\n');
  }
}

// Execute script
seedAndLaunch()
  .then(() => {
    console.log('🎉 Script completed successfully\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Script failed:', error.message);
    process.exit(1);
  });
