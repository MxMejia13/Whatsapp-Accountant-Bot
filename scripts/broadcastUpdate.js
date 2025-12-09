/**
 * Broadcast Update Script - Version 2.0 Launch Announcement
 *
 * Sends a professional email to all users with valid email addresses
 * announcing the new features in Version 2.0
 */

require('dotenv').config();
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

// MongoDB User Schema (simplified for this script)
const UserSchema = new mongoose.Schema({
  phoneNumber: String,
  email: String,
  name: String,
  title: String
});

const User = mongoose.model('User', UserSchema);

/**
 * Create email transporter
 */
function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('Missing SMTP credentials in environment variables');
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

/**
 * Generate HTML email content
 */
function generateEmailHTML(user) {
  const userName = user.name || user.title || 'Usuario';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h3 {
      color: #2c3e50;
      margin-top: 0;
      font-size: 24px;
    }
    h4 {
      color: #3498db;
      margin-top: 25px;
      margin-bottom: 10px;
      font-size: 18px;
    }
    p {
      margin: 15px 0;
      color: #555;
    }
    ul {
      margin: 10px 0;
      padding-left: 20px;
    }
    li {
      margin: 8px 0;
      color: #555;
    }
    strong {
      color: #2c3e50;
    }
    em {
      color: #27ae60;
      font-style: italic;
    }
    hr {
      border: none;
      border-top: 2px solid #ecf0f1;
      margin: 30px 0;
    }
    a {
      color: #3498db;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 2px solid #ecf0f1;
      color: #7f8c8d;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h3>Estimado/a ${userName},</h3>
    <p>Tu Asistente Contable en WhatsApp ha evolucionado. La <strong>Versión 2.0</strong> ya está activa y estas son las 5 herramientas exactas que puedes usar desde hoy:</p>

    <h4>🔒 1. Privacidad "Peer-to-Peer" (Solicitud de Acceso)</h4>
    <p>El sistema ahora es <strong>estrictamente privado</strong>. Nadie puede ver tus archivos sin tu permiso explícito.</p>
    <ul>
      <li><strong>Cómo funciona:</strong> Si el Sr. Vinicio necesita un documento tuyo, el bot te enviará un mensaje de WhatsApp: <em>"Sr. Vinicio solicita ver 'Contrato.pdf'. ¿Autorizar?"</em>. Solo si respondes "Sí", se compartirá.</li>
    </ul>

    <h4>🧠 2. Búsqueda Natural (Adiós a los comandos)</h4>
    <p>Ya no necesitas palabras clave exactas. El bot entiende el contexto y el tiempo.</p>
    <ul>
      <li><strong>Prueba escribir:</strong> <em>"Búscame la factura de La Sirena de la semana pasada"</em></li>
      <li><strong>O intenta:</strong> <em>"Listame todos los pasaportes que tengo guardados"</em></li>
    </ul>

    <h4>📧 3. Nueva "Bóveda de Correo"</h4>
    <p>Ahora tienes un correo exclusivo para archivar documentos automáticamente.</p>
    <ul>
      <li><strong>Tu acción:</strong> Reenvía cualquier factura o recibo a: <strong><a href="mailto:bot@mejiafamily.app">bot@mejiafamily.app</a></strong></li>
      <li><strong>El resultado:</strong> El bot recibirá el correo, analizará el adjunto, extraerá el proveedor/fecha y te avisará por WhatsApp cuando esté guardado.</li>
    </ul>

    <h4>📊 4. Reportes "On-Demand"</h4>
    <p>Genera resúmenes contables al instante para cerrar tu mes.</p>
    <ul>
      <li><strong>Prueba escribir:</strong> <em>"Mándame un reporte de todas las facturas de Noviembre a mi correo"</em></li>
    </ul>

    <h4>⏰ 5. Agenda Inteligente</h4>
    <p>Deja que el bot recuerde los compromisos por ti.</p>
    <ul>
      <li><strong>Prueba escribir:</strong> <em>"Recuérdame pagar la tarjeta mañana a las 9 AM"</em></li>
    </ul>

    <hr>

    <p><strong>¿Cómo empezar?</strong><br>
    Simplemente envía una foto de una factura o escribe <strong>"Ayuda"</strong> en WhatsApp ahora mismo.</p>

    <div class="footer">
      <p>Atentamente,<br>
      <strong>El Equipo de Saldeso</strong></p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Send email to a single user
 */
async function sendEmail(transporter, user) {
  const subject = '🚀 Actualización 2.0: Tu Asistente ahora tiene "Ojos" y "Memoria"';
  const html = generateEmailHTML(user);

  try {
    const info = await transporter.sendMail({
      from: '"Asistente Saldeso" <bot@mejiafamily.app>',
      to: user.email,
      subject: subject,
      html: html
    });

    console.log(`✅ Email sent to ${user.email} (${user.name || user.title || 'Unknown'}): ${info.messageId}`);
    return { success: true, user: user.email };
  } catch (error) {
    console.error(`❌ Failed to send email to ${user.email}:`, error.message);
    return { success: false, user: user.email, error: error.message };
  }
}

/**
 * Main broadcast function
 */
async function broadcastUpdate() {
  console.log('\n🚀 Starting Version 2.0 Broadcast...\n');
  console.log('='.repeat(60));

  try {
    // 1. Connect to MongoDB
    console.log('📡 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // 2. Create email transporter
    console.log('📧 Initializing email service...');
    const transporter = createTransporter();
    console.log('✅ Email service ready\n');

    // 3. Fetch all users with valid email addresses
    console.log('👥 Fetching users with email addresses...');
    const users = await User.find({
      email: { $exists: true, $ne: null, $ne: '' }
    }).select('email name title phoneNumber');

    console.log(`✅ Found ${users.length} users with email addresses\n`);

    if (users.length === 0) {
      console.log('⚠️  No users with email addresses found. Exiting.');
      await mongoose.connection.close();
      return;
    }

    // 4. Send emails with rate limiting
    console.log('📨 Starting email broadcast...\n');
    console.log('='.repeat(60));

    const results = {
      total: users.length,
      success: 0,
      failed: 0,
      errors: []
    };

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const userLabel = `[${i + 1}/${users.length}]`;

      console.log(`${userLabel} Sending to ${user.email}...`);

      const result = await sendEmail(transporter, user);

      if (result.success) {
        results.success++;
      } else {
        results.failed++;
        results.errors.push({
          email: user.email,
          error: result.error
        });
      }

      // Rate limiting: 1 second delay between emails
      if (i < users.length - 1) {
        console.log(`⏳ Waiting 1 second before next email...\n`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 5. Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 BROADCAST SUMMARY:');
    console.log('='.repeat(60));
    console.log(`Total users: ${results.total}`);
    console.log(`✅ Successful: ${results.success}`);
    console.log(`❌ Failed: ${results.failed}`);

    if (results.errors.length > 0) {
      console.log('\n❌ Errors:');
      results.errors.forEach(err => {
        console.log(`   - ${err.email}: ${err.error}`);
      });
    }

    console.log('\n✅ Broadcast complete!\n');

  } catch (error) {
    console.error('\n❌ Broadcast failed:', error);
    throw error;
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('📡 MongoDB connection closed');
  }
}

// Run the broadcast
broadcastUpdate()
  .then(() => {
    console.log('\n🎉 Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Script failed:', error);
    process.exit(1);
  });
