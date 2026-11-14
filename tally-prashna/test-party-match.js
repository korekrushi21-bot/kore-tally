// Offline check of party-name matching with made-up names (no Tally needed).  Run:  node test-party-match.js
const { bestWord, words } = require("./offline");

const NAMES = [
  "Dhanraj Patil,Wadgaon",
  "Dhanraj Biradar,Patilwadi",   // village contains "Patil": must NOT match "dhanraj patil"
  "Dhanraj Shinde,Kasti",
  "Ganesh Patil,Wadgaon",
  "Ganesh Baburao Jadhav,Pimpri",
  "Ganesh Jadhav,Karmala",
  "Ramesh Patil",
  "धनराज पाटील,वडगाव",
  "Dhanaraj Pawar,Kasti",
  "Rajendar Patil,Wadgaon",
];

const cases = [
  ["dhanraj patil balance", ["Dhanraj Patil,Wadgaon"]],
  ["patil dhanraj baki kiti", ["Dhanraj Patil,Wadgaon"]],
  ["dhanraj biradar balance", ["Dhanraj Biradar,Patilwadi"]],
  ["dhanraj balance", ["Dhanraj Patil,Wadgaon", "Dhanraj Biradar,Patilwadi", "Dhanraj Shinde,Kasti", "Dhanaraj Pawar,Kasti"]], // only a first name: all Dhanrajs (correct)
  ["ganesh jadhav balance", ["Ganesh Baburao Jadhav,Pimpri", "Ganesh Jadhav,Karmala"]],
  ["ramesh patil baki", ["Ramesh Patil"]],
  ["patil balance", ["Dhanraj Patil,Wadgaon", "Ganesh Patil,Wadgaon", "Ramesh Patil", "Rajendar Patil,Wadgaon"]],
  ["dhanraj pawar balance", ["Dhanaraj Pawar,Kasti"]],          // spelling variant of the first name
  ["rajendra patil balance", ["Rajendar Patil,Wadgaon"]],       // Rajendra / Rajendar
  ["wadgaon balance", ["Dhanraj Patil,Wadgaon", "Ganesh Patil,Wadgaon", "Rajendar Patil,Wadgaon"]], // village-only question still works
];

let bad = 0;
for (const [q, want] of cases) {
  const got = (bestWord(NAMES, words(q)) || { names: [] }).names;
  const ok = JSON.stringify([...got].sort()) === JSON.stringify([...want].sort());
  if (!ok) bad++;
  console.log((ok ? "OK   " : "FAIL ") + q.padEnd(28) + " -> " + JSON.stringify(got) + (ok ? "" : "\n     expected " + JSON.stringify(want)));
}
console.log(bad ? `\n${bad} case(s) wrong` : "\nall cases right");
process.exit(bad ? 1 : 0);
