# Implementation plan

2026-10-22 Asia/Shanghai. Baseline: GML a80b007494b20e8dc801d063f285e87145cbe15e.

1. M0: independent repository, provenance, Node 22 isolated dependency installation and baseline.
2. M1/M2 batch 1: default-safe runtime mode; production boot must never execute demo reset/seed/token routines; guard destructive seed entrypoints; meaningful regression tests.
3. M2: administrator bootstrap and disabled demo-only network capabilities are included in batch 1; remaining work is session/delegation revocation, authorization fixes, and frontend availability states.
4. M3: core business invariants and end-to-end purchasing/inventory/sales/receivables acceptance.
5. M4: backups/recovery, deployment minimization, security and operational evidence.
6. M5: independent candidate review, three isolated regression rounds, exact-package acceptance; public licensing/release requires explicit owner decisions.

First batch is a bounded security foundation, not the complete ERP or a production release. Preserve the original audit and avoid treating static findings as reproduced until tests run.
