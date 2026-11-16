'use strict'
// no semicolons, closures, nested functions, hoisting, var, ternaries, while with break
console.log(fact(10), fib(15))
function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) }
function fib(n) {
  if (n < 2) return n
  return fib(n - 1) + fib(n - 2)
}
const makeAdder = function (k) { return (x) => x + k }
const add5 = makeAdder(5)
console.log(add5(10), makeAdder(-1)(1))
var words = "the quick brown fox".split(" ")
let longest = ""
for (const w of words) {
  if (w.length > longest.length) longest = w
}
console.log(`longest: ${longest} (${longest.length})`, words.map(w => w.length))
let n = 27, steps = 0
while (true) {
  if (n === 1) break
  n = n % 2 === 0 ? n / 2 : 3 * n + 1
  steps++
}
console.log("steps", steps, 7 / 2, 2 ** 10, Math.floor(-3.5), Math.max(1, 2, 3), -7 % 3, 5 % -3, 5.5 % 2)
const grid = []
for (let r = 0; r < 3; r++) {
  const row = []
  for (let c = 0; c < 3; c++) { row.push(r * 3 + c) }
  grid.push(row)
}
grid[1][1] = 0
let trace = 0
for (let i = 0; i < grid.length; i++) trace += grid[i][i]
console.log(trace, grid[2].includes(8), !grid[0].includes(8) && trace > 5 || false)
const person = { name: "Asha", "home town": "Chennai", tags: ["a", "b"], nested: { ok: true } }
person.age = 30
person.tags.push("c")
console.log(person.name + " is " + person.age + " from " + person["home town"], person.tags.length, person.nested.ok === true)
const stats = (xs) => {
  let lo = xs[0], hi = xs[0]
  for (const x of xs) { if (x < lo) { lo = x } else if (x > hi) { hi = x } }
  return { lo, hi, spread: hi - lo }
}
const s = stats([4, -2, 9, 3])
console.log(s.lo, s.hi, s.spread, null === null, 1 + 2 + "3" + 4 + 5)
let count = 10
for (let i = 10; i > 0; i -= 3) { count += i }
for (let k = 0; k < 4; k++) { if (k === 2) { continue } count += k }
console.log(count, [1, 2, 3, 4].filter(x => x % 2 === 0).reduce((a, b) => a * b, 1), "A,B".toLowerCase().split(","))
