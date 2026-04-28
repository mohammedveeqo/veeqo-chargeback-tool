# Requirements Document

## Introduction

The Veeqo Chargeback Tool currently compares seller-reported dimensions and weights against carrier-audited values to identify chargebacks. However, carriers bill based on the greater of actual weight or dimensional weight, and each carrier has specific surcharge thresholds based on package dimensions. A package with matching actual weights can still incur significant overcharges if the dimensional weights differ due to small dimension discrepancies, or if carrier-audited dimensions push a package into a surcharge tier. This feature adds dimensional weight calculation with carrier-specific divisors, billable weight derivation, cubic volume and length+girth metrics, surcharge flag detection, dispute insight tooltips, and updates the weight comparison logic, spreadsheet display, CSV exports, and email/T.Corp templates to surface this critical billing data.

## Glossary

- **Calculation_Engine**: The `calculateFields` function in `popup.js` that computes derived columns (chargeback amount, weight match, dims match, status) for each merged row.
- **Dimensional_Weight**: A shipping industry metric calculated as (Length × Width × Height) / Divisor, representing the volumetric weight of a package in pounds.
- **DIM_Divisor**: The constant used to convert cubic inches to dimensional weight in pounds. Varies by carrier: 139 for UPS, FedEx, DHL; 166 for USPS.
- **Billable_Weight**: The greater of a package's actual (scale) weight and its dimensional weight. Carriers charge based on billable weight.
- **Cubic_Volume**: The product of Length × Width × Height in cubic inches.
- **Length_Plus_Girth**: Length + (2 × Width) + (2 × Height) in inches, where Length is the longest side.
- **Seller_Dimensional_Weight**: Dimensional weight computed from the seller-reported dimensions (Seller Length, Seller Width, Seller Height).
- **Carrier_Dimensional_Weight**: Dimensional weight computed from the carrier-audited dimensions (Carrier Audited Length, Carrier Audited Width, Carrier Audited Height).
- **Seller_Billable_Weight**: The greater of Seller Weight (lbs) and Seller_Dimensional_Weight.
- **Carrier_Billable_Weight**: The greater of Carrier Audited Weight (lbs) and Carrier_Dimensional_Weight.
- **Weight_Match**: A calculated field indicating whether the seller and carrier billable weights are within tolerance.
- **Surcharge_Flag**: A calculated indicator showing which carrier surcharge thresholds a package triggers based on its dimensions and weight.
- **Dispute_Insight**: A plain-English tooltip message generated per row to help agents understand chargeback context and dispute likelihood.
- **Dispute_Strength**: A colour-coded badge ("Strong", "Moderate", or "Weak") indicating the estimated likelihood of a successful dispute for each row.
- **Merge_Engine**: The `mergeData` function in `popup.js` that joins Task Engine and Datanet rows by tracking number.
- **Table_Renderer**: The `renderTable` function in `popup.js` that displays merged data in the HTML table.
- **Dispute_CSV_Exporter**: The `exportDisputeCSV` function in `popup.js` that generates the dispute CSV file.
- **FedEx_Email_Generator**: The `generateFedExEmail` function in `popup.js` that builds the FedEx QuickResponse email body.
- **TCorpFields_Generator**: The `generateTCorpFields` function in `popup.js` that builds the per-shipment breakdown for T.Corp dispute tickets.

## Requirements

### Requirement 1: Carrier-Specific DIM Divisor

**User Story:** As a chargeback agent, I want the dimensional weight divisor to vary by carrier, so that the tool accurately reflects each carrier's billing methodology.

#### Acceptance Criteria

1. THE Calculation_Engine SHALL use a DIM_Divisor of 139 for UPS shipments.
2. THE Calculation_Engine SHALL use a DIM_Divisor of 139 for FedEx shipments.
3. THE Calculation_Engine SHALL use a DIM_Divisor of 139 for DHL shipments.
4. THE Calculation_Engine SHALL use a DIM_Divisor of 166 for USPS shipments.
5. WHEN the carrier is not recognized (not UPS, FedEx, DHL, or USPS), THE Calculation_Engine SHALL default to a DIM_Divisor of 139.

### Requirement 2: Compute Seller Dimensional Weight

**User Story:** As a chargeback agent, I want the tool to calculate the seller's dimensional weight from the seller-reported package dimensions using the correct carrier divisor, so that I can see the volumetric weight the seller's packaging implies.

#### Acceptance Criteria

1. WHEN a merged row has numeric Seller Length, Seller Width, and Seller Height values, THE Calculation_Engine SHALL compute Seller_Dimensional_Weight as (Seller Length × Seller Width × Seller Height) / DIM_Divisor, rounded to 2 decimal places.
2. WHEN a merged row has one or more seller dimension values equal to 'N/A', THE Calculation_Engine SHALL set Seller_Dimensional_Weight to 'N/A'.
3. WHEN all three seller dimensions are zero, THE Calculation_Engine SHALL compute Seller_Dimensional_Weight as 0.00.

### Requirement 3: Compute Carrier Dimensional Weight

**User Story:** As a chargeback agent, I want the tool to calculate the carrier's dimensional weight from the carrier-audited package dimensions using the correct carrier divisor, so that I can see the volumetric weight the carrier measured.

#### Acceptance Criteria

1. WHEN a merged row has numeric Carrier Audited Length, Carrier Audited Width, and Carrier Audited Height values, THE Calculation_Engine SHALL compute Carrier_Dimensional_Weight as (Carrier Audited Length × Carrier Audited Width × Carrier Audited Height) / DIM_Divisor, rounded to 2 decimal places.
2. WHEN a merged row has one or more carrier dimension values equal to 'N/A', THE Calculation_Engine SHALL set Carrier_Dimensional_Weight to 'N/A'.
3. WHEN all three carrier dimensions are zero, THE Calculation_Engine SHALL compute Carrier_Dimensional_Weight as 0.00.

### Requirement 4: Compute Seller Billable Weight

**User Story:** As a chargeback agent, I want the tool to determine the seller's billable weight as the greater of actual weight and dimensional weight, so that I can see what the seller should be billed for.

#### Acceptance Criteria

1. WHEN both Seller Weight and Seller_Dimensional_Weight are numeric, THE Calculation_Engine SHALL compute Seller_Billable_Weight as the greater of Seller Weight and Seller_Dimensional_Weight.
2. WHEN Seller Weight is 'N/A' and Seller_Dimensional_Weight is numeric, THE Calculation_Engine SHALL set Seller_Billable_Weight to 'N/A'.
3. WHEN Seller Weight is numeric and Seller_Dimensional_Weight is 'N/A', THE Calculation_Engine SHALL set Seller_Billable_Weight to 'N/A'.
4. WHEN both Seller Weight and Seller_Dimensional_Weight are 'N/A', THE Calculation_Engine SHALL set Seller_Billable_Weight to 'N/A'.

### Requirement 5: Compute Carrier Billable Weight

**User Story:** As a chargeback agent, I want the tool to determine the carrier's billable weight as the greater of actual weight and dimensional weight, so that I can see what the carrier is actually billing.

#### Acceptance Criteria

1. WHEN both Carrier Audited Weight and Carrier_Dimensional_Weight are numeric, THE Calculation_Engine SHALL compute Carrier_Billable_Weight as the greater of Carrier Audited Weight and Carrier_Dimensional_Weight.
2. WHEN Carrier Audited Weight is 'N/A' and Carrier_Dimensional_Weight is numeric, THE Calculation_Engine SHALL set Carrier_Billable_Weight to 'N/A'.
3. WHEN Carrier Audited Weight is numeric and Carrier_Dimensional_Weight is 'N/A', THE Calculation_Engine SHALL set Carrier_Billable_Weight to 'N/A'.
4. WHEN both Carrier Audited Weight and Carrier_Dimensional_Weight are 'N/A', THE Calculation_Engine SHALL set Carrier_Billable_Weight to 'N/A'.

### Requirement 6: Compute Cubic Volume

**User Story:** As a chargeback agent, I want the tool to calculate the cubic volume of each package, so that I can determine if surcharge thresholds based on volume are triggered.

#### Acceptance Criteria

1. WHEN a merged row has numeric Carrier Audited Length, Carrier Audited Width, and Carrier Audited Height values, THE Calculation_Engine SHALL compute Cubic_Volume as Carrier Audited Length × Carrier Audited Width × Carrier Audited Height (in cubic inches).
2. WHEN a merged row has one or more carrier dimension values equal to 'N/A', THE Calculation_Engine SHALL set Cubic_Volume to 'N/A'.

### Requirement 7: Compute Length Plus Girth

**User Story:** As a chargeback agent, I want the tool to calculate the length plus girth measurement, so that I can determine if carrier size limits are exceeded.

#### Acceptance Criteria

1. WHEN a merged row has numeric Carrier Audited Length, Carrier Audited Width, and Carrier Audited Height values, THE Calculation_Engine SHALL compute Length_Plus_Girth as Carrier Audited Length + (2 × Carrier Audited Width) + (2 × Carrier Audited Height) in inches, where Length is the longest dimension.
2. WHEN a merged row has one or more carrier dimension values equal to 'N/A', THE Calculation_Engine SHALL set Length_Plus_Girth to 'N/A'.

### Requirement 8: Update Weight Match to Use Billable Weights

**User Story:** As a chargeback agent, I want the weight match comparison to use billable weights instead of raw actual weights, so that dimensional weight discrepancies are detected as mismatches.

#### Acceptance Criteria

1. WHEN both Seller_Billable_Weight and Carrier_Billable_Weight are numeric, THE Calculation_Engine SHALL set Weight_Match to 'Yes' if the absolute difference between Seller_Billable_Weight and Carrier_Billable_Weight is less than or equal to 0.5 lbs.
2. WHEN both Seller_Billable_Weight and Carrier_Billable_Weight are numeric, THE Calculation_Engine SHALL set Weight_Match to 'No' if the absolute difference between Seller_Billable_Weight and Carrier_Billable_Weight is greater than 0.5 lbs.
3. WHEN either Seller_Billable_Weight or Carrier_Billable_Weight is 'N/A', THE Calculation_Engine SHALL set Weight_Match to 'N/A'.

### Requirement 9: Display New Columns in Spreadsheet

**User Story:** As a chargeback agent, I want to see dimensional weight, billable weight, cubic volume, and length+girth columns in the data table, so that I can visually inspect how billing metrics were determined for each shipment.

#### Acceptance Criteria

1. THE Table_Renderer SHALL display a 'Seller Dim Weight (lbs)' column showing the Seller_Dimensional_Weight value for each row.
2. THE Table_Renderer SHALL display a 'Carrier Dim Weight (lbs)' column showing the Carrier_Dimensional_Weight value for each row.
3. THE Table_Renderer SHALL display a 'Seller Billable Weight (lbs)' column showing the Seller_Billable_Weight value for each row.
4. THE Table_Renderer SHALL display a 'Carrier Billable Weight (lbs)' column showing the Carrier_Billable_Weight value for each row.
5. THE Table_Renderer SHALL display a 'Cubic Volume (in³)' column showing the Cubic_Volume value for each row.
6. THE Table_Renderer SHALL display a 'Length + Girth (in)' column showing the Length_Plus_Girth value for each row.
7. THE Table_Renderer SHALL position the six new columns adjacent to the existing weight and dimension columns in the table.

### Requirement 10: Include Billable Weights in Dispute CSV Export

**User Story:** As a chargeback agent, I want the dispute CSV to include seller and carrier billable weights, so that the carrier team can see the dimensional weight comparison in the exported file.

#### Acceptance Criteria

1. WHEN the Dispute_CSV_Exporter generates a CSV file, THE Dispute_CSV_Exporter SHALL include a 'Seller Billable Weight (lbs)' column containing the Seller_Billable_Weight value for each row.
2. WHEN the Dispute_CSV_Exporter generates a CSV file, THE Dispute_CSV_Exporter SHALL include a 'Carrier Billable Weight (lbs)' column containing the Carrier_Billable_Weight value for each row.

### Requirement 11: Include Dimensional Weight in FedEx Email Template

**User Story:** As a chargeback agent, I want the FedEx email template to show dimensional weight and billable weight alongside the existing dimensions block, so that the FedEx QuickResponse team can see exactly how billable weight was calculated.

#### Acceptance Criteria

1. WHEN the FedEx_Email_Generator formats the dimensions block for a shipment, THE FedEx_Email_Generator SHALL output the seller line in the format: `Seller: {L} x {W} x {H} in, {weight} lbs (dim weight: {sellerDimWeight} lbs, billable: {sellerBillableWeight} lbs)`.
2. WHEN the FedEx_Email_Generator formats the dimensions block for a shipment, THE FedEx_Email_Generator SHALL output the carrier line in the format: `Carrier Audit: {L} x {W} x {H} in, {weight} lbs (dim weight: {carrierDimWeight} lbs, billable: {carrierBillableWeight} lbs)`.
3. WHEN Seller_Dimensional_Weight or Seller_Billable_Weight is 'N/A', THE FedEx_Email_Generator SHALL display 'N/A' in the corresponding position of the seller line.
4. WHEN Carrier_Dimensional_Weight or Carrier_Billable_Weight is 'N/A', THE FedEx_Email_Generator SHALL display 'N/A' in the corresponding position of the carrier line.

### Requirement 12: Include Dimensional Weight in T.Corp Template

**User Story:** As a chargeback agent, I want the T.Corp per-shipment breakdown to show dimensional weight and billable weight, so that the carrier dispute team can see the full weight comparison.

#### Acceptance Criteria

1. WHEN the TCorpFields_Generator formats the per-shipment breakdown for a shipment, THE TCorpFields_Generator SHALL include dimensional weight and billable weight in the seller portion in the format: `Seller: {L}x{W}x{H} {weight}lbs (dim: {sellerDimWeight}lbs, billable: {sellerBillableWeight}lbs)`.
2. WHEN the TCorpFields_Generator formats the per-shipment breakdown for a shipment, THE TCorpFields_Generator SHALL include dimensional weight and billable weight in the carrier portion in the format: `Carrier: {L}x{W}x{H} {weight}lbs (dim: {carrierDimWeight}lbs, billable: {carrierBillableWeight}lbs)`.
3. WHEN Seller_Dimensional_Weight or Seller_Billable_Weight is 'N/A', THE TCorpFields_Generator SHALL display 'N/A' in the corresponding position of the seller portion.
4. WHEN Carrier_Dimensional_Weight or Carrier_Billable_Weight is 'N/A', THE TCorpFields_Generator SHALL display 'N/A' in the corresponding position of the carrier portion.

### Requirement 13: FedEx Surcharge Flag Calculations

**User Story:** As a chargeback agent, I want the tool to detect FedEx surcharge thresholds based on package dimensions and weight, so that I can see which surcharges the carrier may apply.

#### Acceptance Criteria

1. THE Calculation_Engine SHALL flag 'AHS-Weight' for FedEx rows WHEN Carrier_Billable_Weight exceeds 50 lbs.
2. THE Calculation_Engine SHALL flag 'AHS-Dimension' for FedEx rows WHEN the longest carrier-audited side exceeds 48 inches OR the second longest carrier-audited side exceeds 30 inches.
3. THE Calculation_Engine SHALL flag 'AHS-Cubic' for FedEx rows WHEN Cubic_Volume exceeds 10,368 cubic inches.
4. THE Calculation_Engine SHALL flag 'Oversize' for FedEx rows WHEN the longest carrier-audited side exceeds 96 inches OR Length_Plus_Girth exceeds 130 inches OR Cubic_Volume exceeds 17,280 cubic inches.
5. THE Calculation_Engine SHALL flag 'Over Max' for FedEx rows WHEN actual weight exceeds 150 lbs OR the longest carrier-audited side exceeds 108 inches OR Length_Plus_Girth exceeds 165 inches.
6. THE Calculation_Engine SHALL flag 'One Rate Exceeded' for FedEx rows WHEN the service name contains "One Rate" AND (Cubic_Volume exceeds 2,200 cubic inches OR actual weight exceeds 50 lbs).

### Requirement 14: UPS Surcharge Flag Calculations

**User Story:** As a chargeback agent, I want the tool to detect UPS surcharge thresholds based on package dimensions and weight, so that I can see which surcharges the carrier may apply.

#### Acceptance Criteria

1. THE Calculation_Engine SHALL flag 'AHS-Weight' for UPS rows WHEN Carrier_Billable_Weight exceeds 50 lbs.
2. THE Calculation_Engine SHALL flag 'AHS-Dimension' for UPS rows WHEN the longest carrier-audited side exceeds 48 inches OR the second longest carrier-audited side exceeds 30 inches.
3. THE Calculation_Engine SHALL flag 'AHS-Cubic' for UPS rows WHEN Cubic_Volume exceeds 10,368 cubic inches.
4. THE Calculation_Engine SHALL flag 'Large Package' for UPS rows WHEN the longest carrier-audited side exceeds 96 inches OR Length_Plus_Girth exceeds 130 inches OR Cubic_Volume exceeds 17,280 cubic inches OR actual weight exceeds 110 lbs.
5. THE Calculation_Engine SHALL flag 'Over Max' for UPS rows WHEN actual weight exceeds 150 lbs OR the longest carrier-audited side exceeds 108 inches OR Length_Plus_Girth exceeds 165 inches.

### Requirement 15: USPS Surcharge Flag Calculations

**User Story:** As a chargeback agent, I want the tool to detect USPS surcharge thresholds based on package dimensions and weight, so that I can see which surcharges the carrier may apply.

#### Acceptance Criteria

1. THE Calculation_Engine SHALL flag 'Non-Standard (small)' for USPS rows WHEN the longest carrier-audited side exceeds 22 inches but is 30 inches or under.
2. THE Calculation_Engine SHALL flag 'Non-Standard (large)' for USPS rows WHEN the longest carrier-audited side exceeds 30 inches.
3. THE Calculation_Engine SHALL flag 'Volume Surcharge' for USPS rows WHEN Cubic_Volume exceeds 3,456 cubic inches.
4. THE Calculation_Engine SHALL flag 'Balloon Pricing' for USPS rows WHEN Length_Plus_Girth exceeds 84 inches but is under 108 inches AND actual weight is under 20 lbs.
5. THE Calculation_Engine SHALL flag 'Over Max' for USPS rows WHEN actual weight exceeds 70 lbs OR Length_Plus_Girth exceeds 130 inches.

### Requirement 16: DHL Surcharge Flag Calculations

**User Story:** As a chargeback agent, I want the tool to detect DHL surcharge thresholds based on package dimensions and weight, so that I can see which surcharges the carrier may apply.

#### Acceptance Criteria

1. THE Calculation_Engine SHALL flag 'AHS-Weight' for DHL rows WHEN Carrier_Billable_Weight exceeds 50 lbs.
2. THE Calculation_Engine SHALL flag 'AHS-Dimension' for DHL rows WHEN the longest carrier-audited side exceeds 48 inches.

### Requirement 17: Surcharge Flag Comparison (Seller vs Carrier)

**User Story:** As a chargeback agent, I want to see whether a surcharge was triggered only by the carrier's measurements or by both seller and carrier measurements, so that I can assess whether the dimension difference caused the surcharge.

#### Acceptance Criteria

1. WHEN a surcharge flag is triggered by carrier-audited dimensions but NOT by seller-entered dimensions, THE Calculation_Engine SHALL annotate the flag as "{flag name} (carrier only)".
2. WHEN a surcharge flag is triggered by BOTH carrier-audited and seller-entered dimensions, THE Calculation_Engine SHALL annotate the flag as "{flag name}".
3. WHEN a surcharge flag is triggered by neither carrier-audited nor seller-entered dimensions, THE Calculation_Engine SHALL NOT display that flag.

### Requirement 18: Display Surcharge Flags in Spreadsheet

**User Story:** As a chargeback agent, I want to see surcharge flags displayed in the data table, so that I can quickly identify which packages trigger carrier surcharges.

#### Acceptance Criteria

1. THE Table_Renderer SHALL display a 'Surcharge Flags' column showing comma-separated surcharge flag tags for each row.
2. WHEN a flag is annotated as "(carrier only)", THE Table_Renderer SHALL display that flag in red text.
3. WHEN a flag is NOT annotated as "(carrier only)", THE Table_Renderer SHALL display that flag in grey text.
4. WHEN a row has no triggered surcharge flags, THE Table_Renderer SHALL display an empty cell for that row's Surcharge Flags column.

### Requirement 19: Dispute Insight Tooltips — Match with No Flag Differences

**User Story:** As a chargeback agent, I want to see contextual insights when seller and carrier data match, so that I understand why a chargeback may still have occurred.

#### Acceptance Criteria

1. WHEN a row's status is "Match" AND no surcharge flags differ between seller and carrier, THE Calculation_Engine SHALL generate the insight: "Seller and carrier data match. The chargeback may be due to rate differences rather than dimension errors. Check the charge breakdown for details."

### Requirement 20: Dispute Insight Tooltips — Small Dimension Difference

**User Story:** As a chargeback agent, I want to see contextual insights when dimension differences are small, so that I understand the carrier's rounding behavior.

#### Acceptance Criteria

1. WHEN a row's status is "Mismatch" AND all individual dimension differences are within 2 inches, THE Calculation_Engine SHALL generate the insight: "Small dimension difference detected. Carriers round up to the nearest inch. If the seller's package was close to a threshold, the carrier's measurement may be correct. Photo evidence showing exact measurements will strengthen this dispute."

### Requirement 21: Dispute Insight Tooltips — Significant Dimensional Weight Difference

**User Story:** As a chargeback agent, I want to see contextual insights when dimensional weight differs significantly, so that I understand the billing impact.

#### Acceptance Criteria

1. WHEN a row's status is "Mismatch" AND the absolute difference between Seller_Dimensional_Weight and Carrier_Dimensional_Weight exceeds 10 lbs, THE Calculation_Engine SHALL generate the insight: "The dimensional weight difference is {X} lbs. Even a small change in dimensions can cause a large billable weight change. The carrier will likely defend their audit. Strong photo evidence is essential." where {X} is the absolute difference rounded to 1 decimal place.

### Requirement 22: Dispute Insight Tooltips — Carrier-Only Surcharge Flag

**User Story:** As a chargeback agent, I want to see contextual insights when a surcharge is triggered only by carrier measurements, so that I understand the dispute strength.

#### Acceptance Criteria

1. WHEN a surcharge flag is triggered by carrier-audited dimensions but NOT by seller-entered dimensions, THE Calculation_Engine SHALL generate the insight: "The carrier's measurements pushed this package into {surcharge name} territory, which the seller's dimensions would not have triggered. This is a strong basis for dispute if the seller can prove their measurements are correct."

### Requirement 23: Dispute Insight Tooltips — Both-Triggered Surcharge Flag

**User Story:** As a chargeback agent, I want to see contextual insights when both seller and carrier trigger the same surcharge, so that I understand the limited dispute value.

#### Acceptance Criteria

1. WHEN a surcharge flag is triggered by BOTH seller and carrier dimensions, THE Calculation_Engine SHALL generate the insight: "Both the seller's and carrier's measurements trigger {surcharge name}. Even if the dispute is approved, this surcharge would still apply. The dispute may only recover the rate difference, not the surcharge."

### Requirement 24: Dispute Insight Tooltips — Small Chargeback Amount

**User Story:** As a chargeback agent, I want to see contextual insights when the chargeback amount is very small, so that I can prioritize my dispute efforts.

#### Acceptance Criteria

1. WHEN the chargeback amount for a row is under $1.00, THE Calculation_Engine SHALL generate the insight: "The chargeback amount is under $1. Consider whether it is worth disputing — carrier teams may deprioritise small amounts."

### Requirement 25: Dispute Insight Tooltips — Over Max Flag

**User Story:** As a chargeback agent, I want to see contextual insights when a package exceeds carrier maximum limits, so that I understand the low likelihood of dispute success.

#### Acceptance Criteria

1. WHEN the 'Over Max' surcharge flag is triggered for a row, THE Calculation_Engine SHALL generate the insight: "This package exceeds carrier maximum limits. Over Max packages are typically rejected or charged at premium rates. Disputes on Over Max charges are rarely successful unless the carrier's measurements are clearly wrong."

### Requirement 26: Dispute Insight Tooltips — One Rate Exceeded (FedEx)

**User Story:** As a chargeback agent, I want to see contextual insights when a FedEx One Rate package exceeds limits, so that I can check for known Veeqo bugs.

#### Acceptance Criteria

1. WHEN the 'One Rate Exceeded' surcharge flag is triggered for a FedEx row, THE Calculation_Engine SHALL generate the insight: "This package exceeded FedEx One Rate limits and was re-rated at standard commercial rates. If the seller entered dimensions within One Rate limits but the carrier audited higher, check for the known Veeqo bug (T.Corp D378661796) where Veeqo shows One Rate for ineligible packages."

### Requirement 27: Display Dispute Insights in Spreadsheet

**User Story:** As a chargeback agent, I want to see dispute insights displayed as tooltips in the data table, so that I can quickly access contextual guidance for each shipment.

#### Acceptance Criteria

1. THE Table_Renderer SHALL display an 'Insights' column containing an info icon for each row that has one or more generated insights.
2. WHEN the agent hovers over or clicks the info icon, THE Table_Renderer SHALL display the insight text as a tooltip.
3. WHEN multiple insights apply to a single row, THE Table_Renderer SHALL display them as a numbered list within the tooltip.
4. WHEN a row has no generated insights, THE Table_Renderer SHALL display an empty cell for that row's Insights column.

### Requirement 28: Dispute Strength Indicator — Weak Classification

**User Story:** As a chargeback agent, I want rows with low dispute success likelihood to be flagged as "Weak", so that I can deprioritise them and focus on winnable disputes.

#### Acceptance Criteria

1. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Weak" WHEN the row's status is "Match" AND no surcharge flags differ between seller and carrier.
2. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Weak" WHEN the 'Over Max' surcharge flag is triggered by carrier-audited dimensions.
3. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Weak" WHEN the chargeback amount is zero or negative.
4. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Weak" WHEN seller dimensions trigger the same surcharge flags as carrier dimensions AND all individual dimension differences are within 1 inch.
5. THE Calculation_Engine SHALL evaluate Weak conditions in the order listed above; the first matching condition wins.

### Requirement 29: Dispute Strength Indicator — Moderate Classification

**User Story:** As a chargeback agent, I want rows with uncertain dispute outcomes to be flagged as "Moderate", so that I know these require further investigation before deciding to dispute.

#### Acceptance Criteria

1. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Moderate" WHEN all individual dimension differences are within 2 inches but Seller_Billable_Weight and Carrier_Billable_Weight differ by more than 5 lbs.
2. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Moderate" WHEN a surcharge flag is triggered by carrier-audited dimensions only AND the seller dimensions are within 10% of the threshold value for that flag.
3. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Moderate" WHEN the chargeback amount is under $5.00.
4. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Moderate" WHEN the 'One Rate Exceeded' surcharge flag is triggered.
5. THE Calculation_Engine SHALL evaluate Moderate conditions only after all Weak conditions have been checked and not matched.

### Requirement 30: Dispute Strength Indicator — Strong Classification

**User Story:** As a chargeback agent, I want rows with high dispute success likelihood to be flagged as "Strong", so that I can prioritise them for immediate action.

#### Acceptance Criteria

1. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Strong" WHEN any individual dimension differs by more than 2 inches AND a surcharge flag is triggered by carrier-audited dimensions only (not seller dimensions).
2. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Strong" WHEN Seller_Billable_Weight and Carrier_Billable_Weight differ by more than 10 lbs AND seller dimensions do not trigger any surcharge flags.
3. THE Calculation_Engine SHALL classify a row's Dispute_Strength as "Strong" WHEN the chargeback amount exceeds $5.00 AND the row's status is "Mismatch" AND no surcharge flags are shared between seller and carrier.
4. THE Calculation_Engine SHALL evaluate Strong conditions only after all Weak and Moderate conditions have been checked and not matched.

### Requirement 31: Dispute Strength Indicator — Default Classification

**User Story:** As a chargeback agent, I want rows that don't clearly fit Strong or Weak to default to "Moderate", so that no row is left without a classification.

#### Acceptance Criteria

1. WHEN none of the Weak, Moderate, or Strong conditions match for a row, THE Calculation_Engine SHALL classify the row's Dispute_Strength as "Moderate".

### Requirement 32: Display Dispute Strength Badge in Spreadsheet

**User Story:** As a chargeback agent, I want to see a colour-coded dispute strength badge in the data table, so that I can quickly scan which disputes are worth pursuing.

#### Acceptance Criteria

1. THE Table_Renderer SHALL display a 'Dispute Strength' column as the second column in the table (after the checkbox column).
2. WHEN Dispute_Strength is "Strong", THE Table_Renderer SHALL display a green badge with the text "Strong".
3. WHEN Dispute_Strength is "Moderate", THE Table_Renderer SHALL display an amber badge with the text "Moderate".
4. WHEN Dispute_Strength is "Weak", THE Table_Renderer SHALL display a red badge with the text "Weak".
5. THE Table_Renderer SHALL allow sorting by the Dispute Strength column so agents can prioritise strong disputes first.

### Requirement 33: Dispute Strength Summary Count

**User Story:** As a chargeback agent, I want to see a summary count of dispute strengths above the table, so that I can quickly assess the overall dispute quality for the current batch.

#### Acceptance Criteria

1. THE Table_Renderer SHALL display a summary line above the data table in the format: "{X} Strong, {Y} Moderate, {Z} Weak" where X, Y, and Z are the counts of rows with each Dispute_Strength classification for the currently active tab.
2. WHEN the active tab changes, THE Table_Renderer SHALL update the summary counts to reflect only the rows visible in the new active tab.
3. WHEN rows are filtered or the data changes, THE Table_Renderer SHALL recalculate and update the summary counts accordingly.
