// A small JavaScript program used to demonstrate the JavaScript -> Tamas converter.
const inventory = [
  { item: "rice", qty: 120, price: 52.5 },
  { item: "wheat", qty: 0, price: 31 },
  { item: "sugar", qty: 45, price: 44 },
];

function gcd(a, b) {
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

const value = (row) => row.qty * row.price;

function describe(row) {
  const status = row.qty === 0 ? "out of stock" : "in stock";
  return `${row.item.toUpperCase()}: ${status}`;
}

let total = 0;
for (const row of inventory) {
  total += value(row);
  console.log(describe(row));
}

const stocked = inventory.filter((r) => r.qty > 0).map((r) => r.item);
console.log("stocked:", stocked.join(", "), "| count", stocked.length);
console.log("total value " + total + ", gcd " + gcd(120, 45) + ", -7 % 3 = " + (-7 % 3));

const squares = [];
for (let i = 1; i <= 5; i++) {
  if (i % 2 === 0) continue;
  squares.push(i ** 2);
}
console.log(squares.reduce((a, b) => a + b, 0), squares.includes(9));
