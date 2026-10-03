const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'PLAN-Separated-Web-Dashboard-And-Discord-Bot-With-Neon-Postgres-05h35m00s-26-09-2026.md');

const plan = fs.readFileSync(filePath, 'utf8');
const lines = plan.split('\n').length;
console.log('Current lines:', lines);
