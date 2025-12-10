#!/usr/bin/env node

/**
 * SendGrid SMTP Connection Test
 * Run this to verify your SendGrid configuration
 */

require('dotenv').config();
const nodemailer = require('nodemailer');

async function testSendGrid() {
  console.log('\n🔍 SendGrid Configuration Test\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Display current configuration (mask sensitive data)
  console.log('📋 Environment Variables:');
  console.log(`   SMTP_HOST: ${process.env.SMTP_HOST || '❌ NOT SET'}`);
  console.log(`   SMTP_PORT: ${process.env.SMTP_PORT || '❌ NOT SET'}`);
  console.log(`   SMTP_USER: ${process.env.SMTP_USER || '❌ NOT SET'}`);
  console.log(`   SMTP_PASS: ${process.env.SMTP_PASS ? `${process.env.SMTP_PASS.substring(0, 5)}...` : '❌ NOT SET'}`);
  console.log(`   SMTP_FROM: ${process.env.SMTP_FROM || '❌ NOT SET'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Check if all required vars are set
  if (!process.env.SMTP_HOST || !process.env.SMTP_PORT || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.SMTP_FROM) {
    console.error('❌ Missing required environment variables!\n');
    console.log('Required variables:');
    console.log('   SMTP_HOST=smtp.sendgrid.net');
    console.log('   SMTP_PORT=587');
    console.log('   SMTP_USER=apikey');
    console.log('   SMTP_PASS=SG.your_api_key_here');
    console.log('   SMTP_FROM=bot@mejiafamily.app\n');
    process.exit(1);
  }

  // Validate SendGrid-specific settings
  console.log('✅ Configuration Validation:');

  if (process.env.SMTP_HOST !== 'smtp.sendgrid.net') {
    console.log(`   ⚠️  SMTP_HOST should be "smtp.sendgrid.net", got "${process.env.SMTP_HOST}"`);
  } else {
    console.log('   ✓ SMTP_HOST is correct');
  }

  if (process.env.SMTP_PORT !== '587') {
    console.log(`   ⚠️  SMTP_PORT should be "587", got "${process.env.SMTP_PORT}"`);
  } else {
    console.log('   ✓ SMTP_PORT is correct');
  }

  if (process.env.SMTP_USER !== 'apikey') {
    console.log(`   ⚠️  SMTP_USER should be literally "apikey", got "${process.env.SMTP_USER}"`);
  } else {
    console.log('   ✓ SMTP_USER is correct');
  }

  if (!process.env.SMTP_PASS.startsWith('SG.')) {
    console.log(`   ⚠️  SMTP_PASS should start with "SG.", got "${process.env.SMTP_PASS.substring(0, 5)}..."`);
  } else {
    console.log('   ✓ SMTP_PASS format looks correct');
  }

  if (!process.env.SMTP_FROM.includes('@mejiafamily.app')) {
    console.log(`   ⚠️  SMTP_FROM should use your verified domain, got "${process.env.SMTP_FROM}"`);
  } else {
    console.log('   ✓ SMTP_FROM uses verified domain');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Test SMTP connection
  console.log('🔌 Testing SMTP Connection...\n');

  const smtpPort = parseInt(process.env.SMTP_PORT) || 587;
  const isSecurePort = smtpPort === 465;

  const transportConfig = {
    host: process.env.SMTP_HOST,
    port: smtpPort,
    secure: isSecurePort,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    family: 4,
    pool: true,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  };

  if (!isSecurePort) {
    transportConfig.tls = {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2'
    };
    transportConfig.requireTLS = true;
  } else {
    transportConfig.tls = {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2'
    };
  }

  try {
    const transporter = nodemailer.createTransport(transportConfig);

    console.log('   📞 Connecting to SendGrid SMTP server...');
    await transporter.verify();

    console.log('\n✅ SUCCESS! SendGrid SMTP connection verified!\n');
    console.log('Your SendGrid configuration is working correctly.');
    console.log('You can now send emails through your WhatsApp bot.\n');

    return true;
  } catch (error) {
    console.error('\n❌ CONNECTION FAILED!\n');
    console.error(`Error Code: ${error.code || 'UNKNOWN'}`);
    console.error(`Error Message: ${error.message}\n`);

    // Provide specific troubleshooting
    if (error.code === 'ETIMEDOUT') {
      console.log('🔧 Troubleshooting ETIMEDOUT:');
      console.log('   1. Verify SMTP_HOST is exactly: smtp.sendgrid.net');
      console.log('   2. Verify SMTP_PORT is exactly: 587');
      console.log('   3. Check if Railway allows outbound connections on port 587');
      console.log('   4. Try redeploying your Railway app after setting env vars\n');
    } else if (error.code === 'EAUTH') {
      console.log('🔧 Troubleshooting EAUTH (Authentication Failed):');
      console.log('   1. Verify SMTP_USER is exactly: apikey');
      console.log('   2. Verify SMTP_PASS is your full SendGrid API key (starts with SG.)');
      console.log('   3. Check that your API key has "Mail Send" permission enabled');
      console.log('   4. Try creating a new API key in SendGrid\n');
    } else if (error.code === 'ECONNREFUSED') {
      console.log('🔧 Troubleshooting ECONNREFUSED:');
      console.log('   1. Verify SMTP_HOST and SMTP_PORT are correct');
      console.log('   2. Check if Railway firewall is blocking the connection\n');
    } else {
      console.log('🔧 General Troubleshooting:');
      console.log('   1. Double-check all environment variables in Railway');
      console.log('   2. Ensure domain authentication is complete in SendGrid');
      console.log('   3. Verify API key is not restricted or expired');
      console.log('   4. Try creating a new API key\n');
    }

    return false;
  }
}

testSendGrid()
  .then(success => process.exit(success ? 0 : 1))
  .catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
