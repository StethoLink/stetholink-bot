# M0.5 dependency audit

The baseline `npm audit` associated Next.js 15.5.29 with its bundled PostCSS 8.4.31. The audit did not report a separate Next.js advisory on that version. The existing Next.js release stays pinned. Its nested PostCSS dependency resolves to the already-used PostCSS 8.5.32 through a Next.js-specific override.

| Package at baseline | Advisory and severity | Resolution |
| --- | --- | --- |
| PostCSS 8.4.31 | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93), moderate (6.1), versions below 8.5.10 | 8.5.32 |
| PostCSS 8.4.31 | [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), high (7.5), through 8.5.11 | 8.5.32 |
| PostCSS 8.4.31 | [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), moderate, through 8.5.22 | 8.5.32 |
| PostCSS 8.4.31 | [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849), high (7.5), through 8.5.17 | 8.5.32 |
| Zod 3.25.76 | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), high (7.5), versions below 4.6.6 | 4.6.7 |
| Vitest and @vitest/mocker 3.2.7 | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) and [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), moderate | 4.1.12 |
| Tinypool 1.1.1 | [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) and [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr), critical | Removed by the Vitest update |
| minimatch 10.2.6 under TypeScript ESLint | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), moderate, 7.0.0 through 11.0.0 | Targeted 11.0.1 override |

Vitest 4 uses Vite 8, which requires Node 20.19 or later on the Node 20 line. The test config sets the JSX transform for existing TSX suites. The post-change npm audit reports zero vulnerabilities.
