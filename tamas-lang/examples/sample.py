"""A small Python program used to demonstrate the Python -> Tamas converter."""
def collatz(n):
    steps = 0
    while n != 1:
        if n % 2 == 0:
            n = n // 2
        else:
            n = 3 * n + 1
        steps += 1
    return steps


scores = {"asha": 91, "ravi": 78}
names = []
for name, score in scores.items():
    if score >= 80:
        names.append(name)
for i, n in enumerate([6, 7, 27]):
    print(f"{i}: collatz({n}) takes", collatz(n), "steps")
print("passed:", names, len(names) > 0 and "asha" in names)
