# Implementation Plan: Dimensional Weight Calculation

## Overview

This plan implements dimensional weight calculation, billable weight derivation, surcharge flag detection, dispute insights, and dispute strength badges into the existing Veeqo Chargeback Tool Chrome extension. All new logic is added to `popup.js` (calculation engine, helpers, constants, updated renderers/exporters) with supporting CSS in `styles.css` and minor HTML additions in `popup.html`. The implementation follows the strict execution order defined in the design: DIM divisor → dimensional weights → billable weights → cubic volume → length+girth → updated weight match → surcharge flags → dispute insights → dispute strength.

## Tasks

- [x] 1. Add surcharge threshold constants and `getDimDivisor` helper
  - [x] 1.1 Add `SURCHARGE_THRESHOLDS` constant object to `popup.js`
    - Define the structured constant with carrier-specific threshold values for FEDEX, UPS, USPS, and DHL as specified in the design data model
    - Place it near the top of `popup.js` after the global state declarations
    - _Requirements: 13.1–13.6, 14.1–14.5, 15.1–15.5, 16.1–16.2_
  - [x] 1.2 Add `getDimDivisor(carrier)` helper function to `popup.js`
    - Return 139 for UPS, FEDEX, DHL; 166 for USPS; default 139 for unrecognized carriers
    - Case-insensitive carrier comparison (carrier is already uppercased by `mapTaskEngineRow`)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - [ ]* 1.3 Write property test for dimensional weight formula (Property 1)
    - **Property 1: Dimensional Weight Formula**
    - Generate random (L, W, H, carrier) tuples; verify dim weight equals `Math.round((L × W × H) / getDimDivisor(carrier) * 100) / 100`
    - **Validates: Requirements 2.1, 3.1**

- [x] 2. Implement `computeSurchargeFlags` helper function
  - [x] 2.1 Add `computeSurchargeFlags(carrier, dims, weight, billableWeight, cubicVolume, lengthPlusGirth, serviceName)` to `popup.js`
    - Accept sorted dims array `[longest, second, third]`, return array of flag name strings
    - Implement FedEx flags: AHS-Weight (billableWeight > 50), AHS-Dimension (longest > 48 OR second > 30), AHS-Cubic (cubicVolume > 10368), Oversize (longest > 96 OR L+G > 130 OR cubicVolume > 17280), Over Max (weight > 150 OR longest > 108 OR L+G > 165), One Rate Exceeded (service contains "One Rate" AND (cubicVolume > 2200 OR weight > 50))
    - Implement UPS flags: AHS-Weight, AHS-Dimension, AHS-Cubic (same thresholds as FedEx), Large Package (longest > 96 OR L+G > 130 OR cubicVolume > 17280 OR weight > 110), Over Max (weight > 150 OR longest > 108 OR L+G > 165)
    - Implement USPS flags: Non-Standard (small) (longest > 22 AND longest ≤ 30), Non-Standard (large) (longest > 30), Volume Surcharge (cubicVolume > 3456), Balloon Pricing (L+G > 84 AND L+G < 108 AND weight < 20), Over Max (weight > 70 OR L+G > 130)
    - Implement DHL flags: AHS-Weight (billableWeight > 50), AHS-Dimension (longest > 48)
    - Return empty array early if any dimension input is `'N/A'`
    - _Requirements: 13.1–13.6, 14.1–14.5, 15.1–15.5, 16.1–16.2_
  - [ ]* 2.2 Write property test for surcharge flag threshold correctness (Property 8)
    - **Property 8: Surcharge Flag Threshold Correctness**
    - Generate random rows per carrier with numeric dims/weights; verify flag set matches threshold rules
    - **Validates: Requirements 13.1–13.6, 14.1–14.5, 15.1–15.5, 16.1–16.2**

- [x] 3. Extend `calculateFields` with dimensional weight, billable weight, volume, and length+girth
  - [x] 3.1 Add dimensional weight, billable weight, cubic volume, and length+girth calculations to `calculateFields`
    - Compute `sellerDimWeight`: `(sellerLength × sellerWidth × sellerHeight) / getDimDivisor(carrier)` rounded to 2dp; set to `'N/A'` if any seller dim is `'N/A'`; compute as 0.00 when all dims are zero
    - Compute `carrierDimWeight`: same formula with carrier-audited dims
    - Compute `sellerBillableWeight`: `Math.max(sellerWeight, sellerDimWeight)`; `'N/A'` if either input is `'N/A'`
    - Compute `carrierBillableWeight`: `Math.max(carrierAuditedWeight, carrierDimWeight)`; `'N/A'` if either input is `'N/A'`
    - Compute `cubicVolume`: carrier L × W × H; `'N/A'` if any carrier dim is `'N/A'`
    - Compute `lengthPlusGirth`: longest + 2×second + 2×third (carrier dims sorted descending); `'N/A'` if any carrier dim is `'N/A'`
    - _Requirements: 2.1–2.3, 3.1–3.3, 4.1–4.4, 5.1–5.4, 6.1–6.2, 7.1–7.2_
  - [x] 3.2 Update weight match logic to use billable weights
    - Replace existing weight match comparison (sellerWeight vs carrierAuditedWeight) with sellerBillableWeight vs carrierBillableWeight using the same 0.5 lb tolerance
    - Set to `'N/A'` when either billable weight is `'N/A'`
    - _Requirements: 8.1, 8.2, 8.3_
  - [ ]* 3.3 Write property tests for N/A propagation (Property 2)
    - **Property 2: N/A Propagation for Dimensional Weight**
    - Generate rows with random N/A placement in dims; verify N/A output
    - **Validates: Requirements 2.2, 3.2**
  - [ ]* 3.4 Write property test for billable weight max selection (Property 3)
    - **Property 3: Billable Weight is Max of Actual and Dimensional**
    - Generate random (actualWeight, dimWeight) pairs; verify max selection
    - **Validates: Requirements 4.1, 5.1**
  - [ ]* 3.5 Write property test for N/A propagation in derived weight fields (Property 4)
    - **Property 4: N/A Propagation for Derived Weight Fields**
    - Generate rows with N/A in weight fields; verify N/A cascades to billable weight and weight match
    - **Validates: Requirements 4.2, 4.3, 4.4, 5.2, 5.3, 5.4, 8.3**
  - [ ]* 3.6 Write property test for cubic volume formula (Property 5)
    - **Property 5: Cubic Volume Formula**
    - Generate random (L, W, H) tuples; verify cubic volume = L×W×H and N/A propagation
    - **Validates: Requirements 6.1, 6.2**
  - [ ]* 3.7 Write property test for length plus girth formula (Property 6)
    - **Property 6: Length Plus Girth Formula**
    - Generate random (L, W, H) tuples; verify L+G = longest + 2×second + 2×third
    - **Validates: Requirements 7.1, 7.2**
  - [ ]* 3.8 Write property test for weight match tolerance (Property 7)
    - **Property 7: Weight Match Uses Billable Weights with 0.5 lb Tolerance**
    - Generate random billable weight pairs; verify 0.5 lb tolerance
    - **Validates: Requirements 8.1, 8.2**

- [x] 4. Checkpoint — Verify core calculations
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Add surcharge flag computation and carrier-only annotation to `calculateFields`
  - [x] 5.1 Add surcharge flag computation to `calculateFields`
    - Call `computeSurchargeFlags` twice per row: once with carrier-audited values, once with seller values
    - Build `surchargeFlags` array of `{ name, carrierOnly }` objects by comparing the two result sets
    - Set `carrierOnly: true` when flag appears in carrier set but not seller set; `carrierOnly: false` when in both
    - When seller dims are `'N/A'`, all carrier-triggered flags get `carrierOnly: true`
    - _Requirements: 17.1, 17.2, 17.3_
  - [ ]* 5.2 Write property test for surcharge flag carrier-only annotation (Property 9)
    - **Property 9: Surcharge Flag Carrier-Only Annotation**
    - Generate random rows with both seller and carrier dims; verify carrierOnly annotation correctness
    - **Validates: Requirements 17.1, 17.2, 17.3**

- [x] 6. Add dispute insight generation to `calculateFields`
  - [x] 6.1 Implement dispute insight rule evaluation in `calculateFields`
    - Evaluate all 8 insight rules in order (Req 19→20→21→22→23→24→25→26) and collect matching insight messages into `disputeInsights` array
    - Rule 19: Match + no surcharge flag differences → rate difference insight
    - Rule 20: Mismatch + all dim diffs ≤ 2 inches → small dimension difference insight
    - Rule 21: Mismatch + |sellerDimWeight − carrierDimWeight| > 10 lbs → significant dim weight difference insight with {X} lbs
    - Rule 22: Carrier-only surcharge flag → strong dispute basis insight per flag
    - Rule 23: Both-triggered surcharge flag → limited dispute value insight per flag
    - Rule 24: Chargeback amount < $1.00 → small chargeback insight
    - Rule 25: Over Max flag triggered → low likelihood insight
    - Rule 26: One Rate Exceeded flag (FedEx) → Veeqo bug reference insight
    - _Requirements: 19.1, 20.1, 21.1, 22.1, 23.1, 24.1, 25.1, 26.1_
  - [ ]* 6.2 Write property test for dispute insight rule completeness (Property 10)
    - **Property 10: Dispute Insight Rule Completeness**
    - Generate random rows; verify insight array matches rule evaluation with no extra or missing messages
    - **Validates: Requirements 19.1, 20.1, 21.1, 22.1, 23.1, 24.1, 25.1, 26.1**

- [x] 7. Add dispute strength classification to `calculateFields`
  - [x] 7.1 Implement dispute strength priority-ordered evaluation in `calculateFields`
    - Evaluate Weak conditions first (W1–W4), then Moderate (M1–M4), then Strong (S1–S3); first match wins; default to 'Moderate'
    - W1: status === 'Match' AND no surcharge flag differences between seller and carrier
    - W2: 'Over Max' flag triggered by carrier-audited dimensions
    - W3: chargebackAmount ≤ 0
    - W4: seller and carrier trigger same flags AND all dim diffs ≤ 1 inch
    - M1: all dim diffs ≤ 2 inches AND billable weight diff > 5 lbs
    - M2: carrier-only surcharge AND seller dims within 10% of threshold
    - M3: chargebackAmount < 5.00
    - M4: 'One Rate Exceeded' flag triggered
    - S1: any dim diff > 2 inches AND carrier-only surcharge flag
    - S2: billable weight diff > 10 lbs AND seller triggers no surcharge flags
    - S3: chargebackAmount > 5.00 AND status === 'Mismatch' AND no shared surcharge flags
    - _Requirements: 28.1–28.5, 29.1–29.5, 30.1–30.4, 31.1_
  - [ ]* 7.2 Write property test for dispute strength classification (Property 11)
    - **Property 11: Dispute Strength Priority-Ordered Classification**
    - Generate random rows; verify dispute strength matches priority-ordered evaluation
    - **Validates: Requirements 28.1–28.5, 29.1–29.5, 30.1–30.4, 31.1**

- [x] 8. Checkpoint — Verify all calculation engine logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Update `COLUMNS` array and `renderTable` for new columns and UI elements
  - [x] 9.1 Update `COLUMNS` array with new column definitions
    - Insert `sellerDimWeight` and `sellerBillableWeight` after existing seller dimension columns
    - Insert `carrierDimWeight` and `carrierBillableWeight` after existing carrier dimension columns
    - Insert `cubicVolume` and `lengthPlusGirth` after carrier weight columns
    - Insert `surchargeFlags` and `disputeInsights` after the status column
    - _Requirements: 9.1–9.7_
  - [x] 9.2 Update `renderTable` to render Dispute Strength badge as second column
    - Add a 'Dispute Strength' `<th>` as the first visible column header (after checkbox)
    - Render green badge for "Strong", amber badge for "Moderate", red badge for "Weak" in each row
    - Support sorting by Dispute Strength column
    - _Requirements: 32.1–32.5_
  - [x] 9.3 Update `renderTable` to render surcharge flags column with colour coding
    - Display comma-separated surcharge flag tags; red text for "(carrier only)" flags, grey text for shared flags
    - Display empty cell when no flags are triggered
    - _Requirements: 18.1–18.4_
  - [x] 9.4 Update `renderTable` to render insights column with tooltip
    - Display info icon (ℹ) for rows with one or more insights; empty cell otherwise
    - Show tooltip on hover/click with numbered list of insight messages
    - _Requirements: 27.1–27.4_
  - [x] 9.5 Add dispute strength summary counts above the data table
    - Display "{X} Strong, {Y} Moderate, {Z} Weak" summary line above the table
    - Update counts when active tab changes or data changes
    - _Requirements: 33.1–33.3_

- [x] 10. Add CSS styles for new UI elements
  - [x] 10.1 Add styles to `styles.css` for dispute strength badges, surcharge flag colours, insight tooltips, and summary counts
    - Green badge (`.badge-strong`), amber badge (`.badge-moderate`), red badge (`.badge-weak`)
    - Red text for carrier-only surcharge flags (`.flag-carrier-only`), grey for shared flags (`.flag-shared`)
    - Tooltip styling for insight popover (`.insight-tooltip`)
    - Summary count bar styling
    - _Requirements: 18.2, 18.3, 32.2, 32.3, 32.4_

- [x] 11. Update export and template functions with dimensional/billable weight data
  - [x] 11.1 Update `exportDisputeCSV` to include billable weight columns
    - Add 'Seller Billable Weight (lbs)' and 'Carrier Billable Weight (lbs)' columns to the dispute CSV headers and row data
    - _Requirements: 10.1, 10.2_
  - [x] 11.2 Update `generateFedExEmail` to include dimensional and billable weight in dimensions block
    - Seller line: `Seller: {L} x {W} x {H} in, {weight} lbs (dim weight: {sellerDimWeight} lbs, billable: {sellerBillableWeight} lbs)`
    - Carrier line: `Carrier Audit: {L} x {W} x {H} in, {weight} lbs (dim weight: {carrierDimWeight} lbs, billable: {carrierBillableWeight} lbs)`
    - Display 'N/A' when dim/billable weight is 'N/A'
    - _Requirements: 11.1, 11.2, 11.3, 11.4_
  - [x] 11.3 Update `generateTCorpFields` to include dimensional and billable weight in per-shipment breakdown
    - Seller: `{L}x{W}x{H} {weight}lbs (dim: {sellerDimWeight}lbs, billable: {sellerBillableWeight}lbs)`
    - Carrier: `{L}x{W}x{H} {weight}lbs (dim: {carrierDimWeight}lbs, billable: {carrierBillableWeight}lbs)`
    - Display 'N/A' when dim/billable weight is 'N/A'
    - _Requirements: 12.1, 12.2, 12.3, 12.4_
  - [ ]* 11.4 Write property test for dispute CSV billable weight columns (Property 12)
    - **Property 12: Dispute CSV Includes Billable Weights**
    - Generate random rows; verify CSV output contains billable weight columns with correct values
    - **Validates: Requirements 10.1, 10.2**
  - [ ]* 11.5 Write property test for FedEx email template format (Property 13)
    - **Property 13: FedEx Email Template Format**
    - Generate random rows; verify FedEx email seller/carrier lines match expected format
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4**
  - [ ]* 11.6 Write property test for T.Corp template format (Property 14)
    - **Property 14: T.Corp Template Format**
    - Generate random rows; verify T.Corp per-shipment breakdown matches expected format
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4**

- [x] 12. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation after core calculation logic and after full integration
- Property tests use fast-check and validate the 14 correctness properties defined in the design
- All new logic stays in `popup.js` — no new source files are introduced
- The strict execution order within `calculateFields` (divisor → dim weights → billable weights → volume → L+G → weight match → surcharge flags → insights → strength) must be maintained
