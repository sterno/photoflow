const fs = require('fs');
const path = require('path');

// Simple test of AI integration
async function testAI() {
  console.log('Testing AI integration...');
  
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('❌ ANTHROPIC_API_KEY not set in environment');
    return;
  }
  
  console.log('✅ ANTHROPIC_API_KEY is configured');
  
  // Test with a simple API call
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 50,
        messages: [
          {
            role: 'user',
            content: 'Just respond with "AI test successful"'
          },
        ],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      console.log('✅ AI API connection successful');
      console.log('Response:', data.content[0].text);
    } else {
      const errorText = await response.text();
      console.log('❌ AI API error:', response.status, errorText);
    }
  } catch (error) {
    console.log('❌ AI API connection failed:', error.message);
  }
}

testAI();