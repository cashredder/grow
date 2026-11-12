# Synthesises the soundtrack: a rising bed, a hit on each cut, and a warm chord on the logo.
import json, math, random, struct, sys, wave

cuts = json.load(open('cuts.json'))
TOTAL, RATE = 23.0, 44100
LOGO = cuts[-1]
n = int(TOTAL * RATE)
out = [0.0] * n
random.seed(7)
tau = 2 * math.pi

def add_hit(at, gain):
    start = int(at * RATE)
    for i in range(int(.35 * RATE)):
        if start + i >= n: break
        t = i / RATE
        pitch = 48 + 90 * math.exp(-t * 30)
        out[start + i] += gain * math.sin(tau * pitch * t) * math.exp(-t * 11)
        out[start + i] += gain * .22 * (random.random() * 2 - 1) * math.exp(-t * 90)

for i in range(n):  # rising bed that stops dead just before the logo
    t = i / RATE
    if t >= LOGO: break
    k = t / LOGO
    env = (k ** 1.6) * .32 * min(1, t / .4)
    if t > LOGO - .08: env *= (LOGO - t) / .08
    base = 55 * 2 ** (k * 1.0)
    s = sum(math.sin(tau * base * m * t + m) / m for m in (1, 2, 3, 4.01))
    out[i] += env * s * (.75 + .25 * math.sin(tau * 4 * t))

for c in cuts[:-1]:
    add_hit(c, .5 + .4 * c / LOGO)
add_hit(LOGO, 1.0)

CHORD = [110, 164.81, 220, 277.18, 329.63, 440]  # A major, open voicing
for i in range(int(LOGO * RATE), n):
    t = i / RATE - LOGO
    env = min(1, t / 1.4) * min(1, (TOTAL - LOGO - t) / 1.6) * .1
    out[i] += env * sum(math.sin(tau * f * t + j) * (1 + .002 * math.sin(tau * .3 * t)) for j, f in enumerate(CHORD))
    sprout = t - 1.9  # a small rising figure as the leaves open
    if sprout > 0:
        for note, at in ((659.25, 0), (880, .22), (1108.73, .44)):
            d = sprout - at
            if d > 0: out[i] += .05 * math.sin(tau * note * d) * math.exp(-d * 2.2)

peak = max(abs(v) for v in out) or 1
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
    w.writeframes(b''.join(struct.pack('<h', int(v / peak * 29000)) for v in out))
print('audio written')
