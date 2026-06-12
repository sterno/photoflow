async function testLogin() {
  try {
    console.log('Testing login endpoint...');
    
    const response = await fetch('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: 'admin',
        password: 'admin123'
      })
    });

    console.log('Response status:', response.status);
    console.log('Response headers:', response.headers);
    
    const cookies = response.headers.get('set-cookie');
    console.log('Cookies:', cookies);
    
    const data = await response.json();
    console.log('Response data:', data);
    
    if (response.ok) {
      console.log('✅ Login successful!');
    } else {
      console.log('❌ Login failed:', data.error);
    }
  } catch (error) {
    console.error('Error testing login:', error);
  }
}

testLogin();