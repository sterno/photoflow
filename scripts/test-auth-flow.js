async function testAuthFlow() {
  console.log('1. Testing login...');
  
  const loginResponse = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: 'admin',
      password: 'admin123'
    })
  });

  console.log('Login response:', loginResponse.status);
  
  const cookies = loginResponse.headers.get('set-cookie');
  console.log('Cookie received:', cookies ? 'Yes' : 'No');
  
  if (!cookies) {
    console.log('❌ No cookie received!');
    return;
  }

  // Extract the auth-token from set-cookie header
  const authToken = cookies.match(/auth-token=([^;]+)/)?.[1];
  console.log('Token extracted:', authToken ? 'Yes' : 'No');

  console.log('\n2. Testing /api/auth/me with cookie...');
  
  const meResponse = await fetch('http://localhost:3000/api/auth/me', {
    headers: {
      'Cookie': `auth-token=${authToken}`
    }
  });

  console.log('Me response:', meResponse.status);
  
  if (meResponse.ok) {
    const userData = await meResponse.json();
    console.log('User data:', userData);
    console.log('✅ Auth flow working!');
  } else {
    const error = await meResponse.json();
    console.log('❌ Auth check failed:', error);
  }
}

testAuthFlow().catch(console.error);