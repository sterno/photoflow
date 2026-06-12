const fs = require('fs');
const sharp = require('sharp');

async function testMetadataExtraction() {
  console.log('Testing metadata extraction...');
  
  // Create a simple test image buffer
  const testImage = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 100, g: 150, b: 200 }
    }
  }).jpeg().toBuffer();

  console.log('✅ Generated test image buffer:', testImage.length, 'bytes');
  
  // Test metadata extraction
  try {
    const metadata = await sharp(testImage).metadata();
    console.log('✅ Sharp metadata extraction works:', {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format
    });
  } catch (error) {
    console.log('❌ Sharp metadata extraction failed:', error.message);
  }
}

testMetadataExtraction();