/*
 * WMM — magnetic declination from the World Magnetic Model 2025.
 *
 * Computed in the browser rather than fetched. NOAA's geomagnetic calculator
 * does send CORS headers, but it now requires a registered API key, and a key
 * shipped in a static page is a public key — plus it would make declination a
 * network round trip on a boat with no signal. The model is small enough to
 * carry: 90 spherical-harmonic coefficients, degree 12.
 *
 * Coefficients are the official WMM2025.COF (epoch 2025.0, released
 * 2024-11-13), unmodified. VALID 2025-01-01 THROUGH 2029-12-31 — after that
 * the model must be replaced or declination silently drifts out of spec, so
 * isExpired() exists to let the UI say so rather than quietly lying.
 *
 * Verified against all 100 cases in NOAA's WMM2025_TestValues.txt.
 */
const WMM = (function () {
  const EPOCH = 2025.0;
  const VALID_UNTIL = 2030.0;
  const A = 6378.137;              // WGS-84 semi-major axis, km
  const F = 1 / 298.257223563;
  const E2 = F * (2 - F);          // first eccentricity squared
  const RE = 6371.2;               // geomagnetic reference radius, km

  /* n m g h dg/dt dh/dt — official WMM2025.COF, verbatim */
  const COF =
    '1 0 -29351.8 0.0 12.0 0.0;1 1 -1410.8 4545.4 9.7 -21.5;2 0 -2556.6 0.0 -11.6 0.0;' +
    '2 1 2951.1 -3133.6 -5.2 -27.7;2 2 1649.3 -815.1 -8.0 -12.1;3 0 1361.0 0.0 -1.3 0.0;' +
    '3 1 -2404.1 -56.6 -4.2 4.0;3 2 1243.8 237.5 0.4 -0.3;3 3 453.6 -549.5 -15.6 -4.1;' +
    '4 0 895.0 0.0 -1.6 0.0;4 1 799.5 278.6 -2.4 -1.1;4 2 55.7 -133.9 -6.0 4.1;' +
    '4 3 -281.1 212.0 5.6 1.6;4 4 12.1 -375.6 -7.0 -4.4;5 0 -233.2 0.0 0.6 0.0;' +
    '5 1 368.9 45.4 1.4 -0.5;5 2 187.2 220.2 0.0 2.2;5 3 -138.7 -122.9 0.6 0.4;' +
    '5 4 -142.0 43.0 2.2 1.7;5 5 20.9 106.1 0.9 1.9;6 0 64.4 0.0 -0.2 0.0;' +
    '6 1 63.8 -18.4 -0.4 0.3;6 2 76.9 16.8 0.9 -1.6;6 3 -115.7 48.8 1.2 -0.4;' +
    '6 4 -40.9 -59.8 -0.9 0.9;6 5 14.9 10.9 0.3 0.7;6 6 -60.7 72.7 0.9 0.9;' +
    '7 0 79.5 0.0 -0.0 0.0;7 1 -77.0 -48.9 -0.1 0.6;7 2 -8.8 -14.4 -0.1 0.5;' +
    '7 3 59.3 -1.0 0.5 -0.8;7 4 15.8 23.4 -0.1 0.0;7 5 2.5 -7.4 -0.8 -1.0;' +
    '7 6 -11.1 -25.1 -0.8 0.6;7 7 14.2 -2.3 0.8 -0.2;8 0 23.2 0.0 -0.1 0.0;' +
    '8 1 10.8 7.1 0.2 -0.2;8 2 -17.5 -12.6 0.0 0.5;8 3 2.0 11.4 0.5 -0.4;' +
    '8 4 -21.7 -9.7 -0.1 0.4;8 5 16.9 12.7 0.3 -0.5;8 6 15.0 0.7 0.2 -0.6;' +
    '8 7 -16.8 -5.2 -0.0 0.3;8 8 0.9 3.9 0.2 0.2;9 0 4.6 0.0 -0.0 0.0;9 1 7.8 -24.8 -0.1 -0.3;' +
    '9 2 3.0 12.2 0.1 0.3;9 3 -0.2 8.3 0.3 -0.3;9 4 -2.5 -3.3 -0.3 0.3;9 5 -13.1 -5.2 0.0 0.2;' +
    '9 6 2.4 7.2 0.3 -0.1;9 7 8.6 -0.6 -0.1 -0.2;9 8 -8.7 0.8 0.1 0.4;9 9 -12.9 10.0 -0.1 0.1;' +
    '10 0 -1.3 0.0 0.1 0.0;10 1 -6.4 3.3 0.0 0.0;10 2 0.2 0.0 0.1 -0.0;10 3 2.0 2.4 0.1 -0.2;' +
    '10 4 -1.0 5.3 -0.0 0.1;10 5 -0.6 -9.1 -0.3 -0.1;10 6 -0.9 0.4 0.0 0.1;' +
    '10 7 1.5 -4.2 -0.1 0.0;10 8 0.9 -3.8 -0.1 -0.1;10 9 -2.7 0.9 -0.0 0.2;' +
    '10 10 -3.9 -9.1 -0.0 -0.0;11 0 2.9 0.0 0.0 0.0;11 1 -1.5 0.0 -0.0 -0.0;' +
    '11 2 -2.5 2.9 0.0 0.1;11 3 2.4 -0.6 0.0 -0.0;11 4 -0.6 0.2 0.0 0.1;' +
    '11 5 -0.1 0.5 -0.1 -0.0;11 6 -0.6 -0.3 0.0 -0.0;11 7 -0.1 -1.2 -0.0 0.1;' +
    '11 8 1.1 -1.7 -0.1 -0.0;11 9 -1.0 -2.9 -0.1 0.0;11 10 -0.2 -1.8 -0.1 0.0;' +
    '11 11 2.6 -2.3 -0.1 0.0;12 0 -2.0 0.0 0.0 0.0;12 1 -0.2 -1.3 0.0 -0.0;' +
    '12 2 0.3 0.7 -0.0 0.0;12 3 1.2 1.0 -0.0 -0.1;12 4 -1.3 -1.4 -0.0 0.1;' +
    '12 5 0.6 -0.0 -0.0 -0.0;12 6 0.6 0.6 0.1 -0.0;12 7 0.5 -0.1 -0.0 -0.0;' +
    '12 8 -0.1 0.8 0.0 0.0;12 9 -0.4 0.1 0.0 -0.0;12 10 -0.2 -1.0 -0.1 -0.0;' +
    '12 11 -1.3 0.1 -0.0 0.0;12 12 -0.7 0.2 -0.1 -0.1';

  const g = [], h = [], gd = [], hd = [];
  let NMAX = 0;
  COF.split(';').forEach((row) => {
    const p = row.split(' ');
    const n = +p[0], m = +p[1];
    if (!g[n]) { g[n] = []; h[n] = []; gd[n] = []; hd[n] = []; }
    g[n][m] = +p[2]; h[n][m] = +p[3]; gd[n][m] = +p[4]; hd[n][m] = +p[5];
    if (n > NMAX) NMAX = n;
  });

  const decimalYear = (date) => {
    const d = date || new Date();
    const y = d.getUTCFullYear();
    const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
    return y + (d.getTime() - start) / (end - start);
  };

  /*
   * Schmidt semi-normalised associated Legendre functions and their theta
   * derivatives, by the standard recursions. Doing the normalisation inside the
   * recursion (rather than computing unnormalised polynomials and scaling
   * afterwards) is what keeps this stable at degree 12.
   */
  function legendre(theta) {
    const st = Math.sin(theta), ct = Math.cos(theta);
    const P = [], dP = [];
    for (let n = 0; n <= NMAX; n++) { P[n] = new Array(NMAX + 1).fill(0); dP[n] = new Array(NMAX + 1).fill(0); }
    P[0][0] = 1; dP[0][0] = 0;
    for (let n = 1; n <= NMAX; n++) {
      // sectoral term
      // Schmidt sectoral recursion. P(1,1) is exactly sin(theta); the
      // sqrt((2n-1)/2n) factor only enters from n = 2.
      const kx = (n === 1) ? 1 : Math.sqrt((2 * n - 1) / (2 * n));
      P[n][n] = kx * st * P[n - 1][n - 1];
      dP[n][n] = kx * (st * dP[n - 1][n - 1] + ct * P[n - 1][n - 1]);
      for (let m = 0; m < n; m++) {
        const d1 = Math.sqrt(n * n - m * m);
        const d2 = Math.sqrt((n - 1) * (n - 1) - m * m);
        const Pn2 = (n - 2 >= m) ? P[n - 2][m] : 0;
        const dPn2 = (n - 2 >= m) ? dP[n - 2][m] : 0;
        P[n][m] = ((2 * n - 1) * ct * P[n - 1][m] - d2 * Pn2) / d1;
        dP[n][m] = ((2 * n - 1) * (ct * dP[n - 1][m] - st * P[n - 1][m]) - d2 * dPn2) / d1;
      }
    }
    return { P: P, dP: dP, st: st, ct: ct };
  }

  /*
   * Field at a geodetic position. Declination is east-positive degrees; the
   * other components come along so a dip/intensity readout can be added later
   * without touching this.
   */
  function field(latDeg, lonDeg, altKm, date) {
    const t = decimalYear(date) - EPOCH;
    const alt = altKm || 0;
    const latR = latDeg * Math.PI / 180;
    const lonR = lonDeg * Math.PI / 180;
    const sinLat = Math.sin(latR), cosLat = Math.cos(latR);

    // geodetic -> geocentric spherical
    const Rn = A / Math.sqrt(1 - E2 * sinLat * sinLat);      // prime vertical radius
    const pxy = (Rn + alt) * cosLat;
    const pz = (Rn * (1 - E2) + alt) * sinLat;
    const r = Math.sqrt(pxy * pxy + pz * pz);
    const geocLat = Math.atan2(pz, pxy);
    const theta = Math.PI / 2 - geocLat;                     // colatitude

    const { P, dP, st } = legendre(theta);

    const sp = [0], cp = [1];
    for (let m = 1; m <= NMAX; m++) {
      sp[m] = Math.sin(m * lonR);
      cp[m] = Math.cos(m * lonR);
    }

    let Xg = 0, Yg = 0, Zg = 0;                              // geocentric N/E/down
    for (let n = 1; n <= NMAX; n++) {
      const ar = Math.pow(RE / r, n + 2);
      for (let m = 0; m <= n; m++) {
        const gt = g[n][m] + t * gd[n][m];
        const ht = (h[n][m] || 0) + t * (hd[n][m] || 0);
        const cs = gt * cp[m] + ht * sp[m];
        const sc = gt * sp[m] - ht * cp[m];
        // X(north) = -Btheta, and Btheta carries its own minus, so this is +
        Xg += ar * cs * dP[n][m];
        Zg -= ar * (n + 1) * cs * P[n][m];
        if (m > 0) Yg += ar * m * sc * P[n][m] / (Math.abs(st) < 1e-10 ? 1e-10 : st);
      }
    }

    // rotate geocentric -> geodetic by the latitude difference
    const psi = geocLat - latR;
    const X = Xg * Math.cos(psi) - Zg * Math.sin(psi);
    const Z = Xg * Math.sin(psi) + Zg * Math.cos(psi);
    const Y = Yg;

    const H = Math.sqrt(X * X + Y * Y);
    return {
      declination: Math.atan2(Y, X) * 180 / Math.PI,
      inclination: Math.atan2(Z, H) * 180 / Math.PI,
      intensity: Math.sqrt(H * H + Z * Z),
      H: H, X: X, Y: Y, Z: Z
    };
  }

  const declination = (lat, lon, date) => field(lat, lon, 0, date).declination;
  const isExpired = (date) => decimalYear(date) >= VALID_UNTIL;

  return {
    field: field,
    declination: declination,
    isExpired: isExpired,
    EPOCH: EPOCH,
    VALID_UNTIL: VALID_UNTIL,
    decimalYear: decimalYear
  };
})();

window.WMM = WMM;
