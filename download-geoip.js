#!/usr/bin/env node

/**
 * Helper script to download MaxMind GeoLite2 Country database
 * 
 * Note: MaxMind now requires an account and license key.
 * This script provides instructions for manual download.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'GeoLite2-Country.mmdb');

console.log('=== GeoLite2 Country Database Setup ===\n');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('✓ Created data directory');
}

// Check if database already exists
if (fs.existsSync(DB_PATH)) {
  const stats = fs.statSync(DB_PATH);
  const age = Math.floor((Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24));
  console.log(`✓ Database already exists (${age} days old)`);
  console.log(`  Location: ${DB_PATH}`);
  
  if (age > 30) {
    console.log('\n⚠  Database is older than 30 days. Consider updating it.');
  }
  
  console.log('\nTo update, delete the file and run this script again.');
  process.exit(0);
}

console.log('GeoLite2 databases are free but require registration.\n');
console.log('Option 1: Download manually (Recommended)');
console.log('  1. Sign up at: https://dev.maxmind.com/geoip/geolite2-free-geolocation-data');
console.log('  2. Download GeoLite2 Country database (MMDB format)');
console.log('  3. Extract GeoLite2-Country.mmdb to:');
console.log(`     ${DB_PATH}\n`);

console.log('Option 2: Use license key (if you have one)');
console.log('  Set MAXMIND_LICENSE_KEY environment variable and run:');
console.log('  MAXMIND_LICENSE_KEY=your_key node download-geoip.js\n');

const licenseKey = process.env.MAXMIND_LICENSE_KEY;

if (licenseKey) {
  console.log('License key detected, attempting download...\n');
  
  const url = `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&license_key=${licenseKey}&suffix=tar.gz`;
  const tarPath = path.join(DATA_DIR, 'GeoLite2-Country.tar.gz');
  
  console.log('Downloading database...');
  
  try {
    // Download the tar.gz file
    const file = fs.createWriteStream(tarPath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        console.error(`✗ Download failed: HTTP ${response.statusCode}`);
        console.error('  Please check your license key or download manually.');
        process.exit(1);
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log('✓ Downloaded');
        
        try {
          console.log('Extracting...');
          
          // Extract tar.gz
          execSync(`tar -xzf "${tarPath}" -C "${DATA_DIR}"`, { stdio: 'pipe' });
          
          // Find the .mmdb file in extracted directory
          const files = fs.readdirSync(DATA_DIR);
          const extractedDir = files.find(f => f.startsWith('GeoLite2-Country_'));
          
          if (extractedDir) {
            const mmdbSource = path.join(DATA_DIR, extractedDir, 'GeoLite2-Country.mmdb');
            if (fs.existsSync(mmdbSource)) {
              fs.renameSync(mmdbSource, DB_PATH);
              
              // Cleanup
              fs.unlinkSync(tarPath);
              fs.rmSync(path.join(DATA_DIR, extractedDir), { recursive: true });
              
              console.log('✓ Installation complete!');
              console.log(`  Database location: ${DB_PATH}`);
              process.exit(0);
            }
          }
          
          console.error('✗ Could not find .mmdb file in extracted archive');
          process.exit(1);
        } catch (err) {
          console.error('✗ Extraction failed:', err.message);
          console.error('  Please extract manually and place GeoLite2-Country.mmdb in:');
          console.error(`  ${DB_PATH}`);
          process.exit(1);
        }
      });
    }).on('error', (err) => {
      fs.unlinkSync(tarPath);
      console.error('✗ Download error:', err.message);
      process.exit(1);
    });
  } catch (err) {
    console.error('✗ Error:', err.message);
    process.exit(1);
  }
} else {
  console.log('No license key provided. Please download manually or set MAXMIND_LICENSE_KEY.');
  process.exit(0);
}


