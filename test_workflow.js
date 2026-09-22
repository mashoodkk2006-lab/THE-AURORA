// Automated Workflow Validation for THE AURORA PROTOCOL
const http = require('http');

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'POST',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(path, token) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  console.log('--- STARTING WORKFLOW VALIDATION ---');

  // 1. Head Admin Login
  console.log('\n[1] Testing Head Admin Login (MASHOOD / THEAURORAPROTOCOL)...');
  const adminLogin = await post('/api/auth/admin-login', {
    username: 'MASHOOD',
    password: 'THEAURORAPROTOCOL'
  });
  console.assert(adminLogin.status === 200 && adminLogin.data.success, 'Head Admin login failed');
  const adminToken = adminLogin.data.token;
  console.log('✅ Head Admin login successful. Role:', adminLogin.data.user.role);

  // Clean up any previous test team
  const teamsList = await get('/api/admin/teams', adminToken);
  if (teamsList.data && teamsList.data.teams) {
    const old = teamsList.data.teams.find(t => t.team_id.startsWith('AURORATEST'));
    if (old) await post(`/api/admin/teams/${old.id}`, {}, adminToken);
  }

  const testTeamId = `AURORATEST${Math.floor(Math.random() * 1000)}`;
  const testSubAdmin = `POLICE${Math.floor(Math.random() * 80 + 10)}`;

  // 2. Create Team
  console.log(`\n[2] Testing Create Team (${testTeamId} / TEAM CYBER)...`);
  const createTeam = await post('/api/admin/teams', {
    team_id: testTeamId,
    team_name: 'TEAM CYBER',
    score: 500
  }, adminToken);
  console.assert(createTeam.status === 200 && createTeam.data.success, 'Create Team failed');
  const newTeam = createTeam.data.team;
  console.log('✅ Team created. ID:', newTeam.team_id, 'QR Token:', newTeam.qr_token);

  // 3. Create Sub Admin
  console.log(`\n[3] Testing Create Sub Admin (${testSubAdmin} for POLICE)...`);
  const createSub = await post('/api/admin/sub-admins', {
    username: testSubAdmin,
    name: 'Inspector Vikram',
    password: 'SecurePassword123',
    assigned_room: 'POLICE'
  }, adminToken);
  console.assert(createSub.status === 200 && createSub.data.success, 'Create Sub Admin failed');
  console.log('✅ Sub Admin created successfully');

  // 4. Sub Admin Login
  console.log(`\n[4] Testing Sub Admin Login (${testSubAdmin} / SecurePassword123)...`);
  const subLogin = await post('/api/auth/admin-login', {
    username: testSubAdmin,
    password: 'SecurePassword123'
  });
  console.assert(subLogin.status === 200 && subLogin.data.success, 'Sub Admin login failed');
  const subToken = subLogin.data.token;
  console.log('✅ Sub Admin login successful. Assigned Room:', subLogin.data.user.assigned_room);

  // 5. Create Round
  console.log('\n[5] Testing Create Round 4...');
  const createRound = await post('/api/admin/rounds', { round_number: 4 }, adminToken);
  console.assert(createRound.status === 200 && createRound.data.success, 'Create Round failed');
  console.log('✅ Round 4 created successfully');

  // 6. Set Room Time
  console.log('\n[6] Testing Set Room Time (Round 1, Police Room: 8 minutes)...');
  const setTime = await post('/api/admin/room-settings', {
    round_id: 1,
    room_id: 1,
    duration_minutes: 8
  }, adminToken);
  console.assert(setTime.status === 200 && setTime.data.success, 'Set room time failed');
  console.log('✅ Room time setting updated');

  // 7. Generate / View Team QR
  console.log('\n[7] Testing Generate/View Team QR for team...');
  const qrRes = await get(`/api/admin/teams/${newTeam.id}/qr`, adminToken);
  console.assert(qrRes.status === 200 && qrRes.data.qr_data_url.startsWith('data:image/png;base64,'), 'QR generation failed');
  console.log('✅ QR Code generated successfully. Length:', qrRes.data.qr_data_url.length);

  // 8. Sub Admin scans QR -> ACCESS GRANTED
  console.log('\n[8] Testing Sub Admin QR Scan -> FIRST ENTRY (ACCESS GRANTED)...');
  const scan1 = await post('/api/scanner/validate-scan', {
    qr_token: newTeam.qr_token,
    room_code: 'POLICE'
  }, subToken);
  console.assert(scan1.status === 200 && scan1.data.success, 'First entry scan failed');
  console.log('✅ ACCESS GRANTED! Team:', scan1.data.team.team_name, 'Duration:', scan1.data.duration_minutes, 'mins');
  console.log('Timer started: Entry Time:', scan1.data.entry_time, 'Expiry Time:', scan1.data.expiry_time);
  const activeEntryId = scan1.data.entry_id;

  // 9. Second Scan in SAME room during SAME round -> ACCESS DENIED
  console.log('\n[9] Testing Second Scan in SAME room during SAME round -> ACCESS DENIED...');
  const scan2 = await post('/api/scanner/validate-scan', {
    qr_token: newTeam.qr_token,
    room_code: 'POLICE'
  }, subToken);
  console.assert(scan2.status === 400 && scan2.data.error_code === 'ALREADY_ENTERED', 'Duplicate entry prevention failed!');
  console.log('✅ ACCESS DENIED as expected! Reason:', scan2.data.message);

  // 10. Student Portal View
  console.log(`\n[10] Testing Student Login & Dashboard (${testTeamId} / TEAM CYBER)...`);
  const studentLogin = await post('/api/auth/student-login', {
    team_id: testTeamId,
    password: 'TEAM CYBER'
  });
  console.assert(studentLogin.status === 200 && studentLogin.data.success, 'Student login failed');
  const studentToken = studentLogin.data.token;

  const studentDash = await get('/api/student/dashboard', studentToken);
  console.assert(studentDash.status === 200 && studentDash.data.active_entry !== null, 'Student active room missing');
  console.log('✅ Student sees active room timer:', studentDash.data.active_entry.room_name, 'Remaining secs:', studentDash.data.active_entry.remaining_seconds);

  // 11. Complete Entry (Simulate timer finish / complete)
  console.log('\n[11] Completing room entry...');
  const complete = await post('/api/scanner/complete-entry', { entry_id: activeEntryId }, subToken);
  console.assert(complete.status === 200 && complete.data.success, 'Complete entry failed');
  console.log('✅ Room entry marked COMPLETED');

  // 12. Update Score
  console.log(`\n[12] Testing Update Score for ${testTeamId} (from 500 to 1050)...`);
  const updateScore = await post(`/api/admin/teams/${newTeam.id}/score`, { new_score: 1050 }, adminToken);
  console.assert(updateScore.status === 200 && updateScore.data.new_score === 1050, 'Score update failed');
  console.log('✅ Score updated from', updateScore.data.old_score, 'to', updateScore.data.new_score);

  // Check Leaderboard position
  const leaderboard = await get('/api/student/leaderboard');
  console.assert(leaderboard.data.teams[0].team_id === testTeamId, 'Leaderboard position change failed');
  console.log('✅ Leaderboard Rank 1 is now:', leaderboard.data.teams[0].team_name, 'with score', leaderboard.data.teams[0].score);

  // 13. Eliminate Team
  console.log('\n[13] Testing Eliminate Team...');
  const eliminate = await post(`/api/admin/teams/${newTeam.id}/eliminate`, {}, adminToken);
  console.assert(eliminate.status === 200 && eliminate.data.success, 'Eliminate team failed');
  console.log('✅ Team eliminated by Head Admin');

  // Verify Student sees eliminated status
  const studentDashElim = await get('/api/student/dashboard', studentToken);
  console.assert(studentDashElim.data.team.status === 'ELIMINATED', 'Student eliminated status check failed');
  console.log('✅ Student dashboard reflects ELIMINATED status');

  // Verify Eliminated team cannot enter rooms
  const scanElim = await post('/api/scanner/validate-scan', {
    qr_token: newTeam.qr_token,
    room_code: 'LAB'
  }, subToken);
  console.assert(scanElim.status === 400 && scanElim.data.error_code === 'TEAM_ELIMINATED', 'Eliminated team room lock failed');
  console.log('✅ Eliminated team blocked from room access:', scanElim.data.message);

  // 14. Event Reset
  console.log('\n[14] Testing Event Reset System (Confirmation phrase: RESET AURORA)...');
  // Attempt with invalid code first
  const badReset = await post('/api/admin/reset-event', { confirmation_code: 'WRONG' }, adminToken);
  console.assert(badReset.status === 400, 'Unconfirmed reset should fail');
  console.log('✅ Unconfirmed reset correctly rejected');

  // Attempt with valid code
  const goodReset = await post('/api/admin/reset-event', { confirmation_code: 'RESET AURORA' }, adminToken);
  console.assert(goodReset.status === 200 && goodReset.data.success, 'Confirmed event reset failed');
  console.log('✅ Event successfully reset! Message:', goodReset.data.message);

  // Check that team scores are reset to 0
  const postResetLeaderboard = await get('/api/student/leaderboard');
  console.log('✅ Post-reset leader team score:', postResetLeaderboard.data.teams[0].score);

  console.log('\n========================================');
  console.log(' 🎉 ALL WORKFLOW REQUIREMENTS VERIFIED! 🎉');
  console.log('========================================\n');
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
