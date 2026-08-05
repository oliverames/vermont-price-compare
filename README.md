# Vermont Price Compare

Vermont Price Compare is a static demonstration site for comparing published healthcare procedure prices. The live site is at [oliverames.github.io/vermont-price-compare](https://oliverames.github.io/vermont-price-compare/).

The demo includes five CPT-coded procedures:

- Screening colonoscopy without biopsy, CPT 45378
- Bilateral screening mammography with computer-aided detection, CPT 77067
- Lower-extremity joint MRI without contrast, CPT 73721
- Abdomen and pelvis CT with contrast, CPT 74177
- Carpal tunnel release surgery, CPT 64721

## What the prices mean

The default view uses total gross charges from the Vermont Department of Health's 2026 Hospital Report Cards. These totals combine the hospital and hospital-employed physician amounts shown in each report. They do not reflect insurance discounts or a patient's out-of-pocket cost.

Four procedures also have a separate cash-price view. Those values come from current hospital machine-readable files. The files may not identify every billing component, and other providers may bill separately.

Green Mountain Surgery Center publishes facility charges for two matching codes. The interface keeps those amounts outside the hospital-total rankings because the billing components differ.

## Primary sources

- [Vermont Hospital Report Cards](https://www.healthvermont.gov/systems/hospitals-health-systems/hospital-report-cards)
- [2026 colonoscopy gross charges](https://www.healthvermont.gov/sites/default/files/document/hsi-stats-hrc-2026-cpt-j-diag_0.pdf)
- [2026 mammography gross charges](https://www.healthvermont.gov/sites/default/files/document/hsi-stats-hrc-2026-cpt-h-mam_0.pdf)
- [2026 MRI gross charges](https://www.healthvermont.gov/sites/default/files/document/hsi-stats-hrc-2026-cpt-f-mri_0.pdf)
- [2026 CT gross charges](https://www.healthvermont.gov/sites/default/files/document/hsi-stats-hrc-2026-cpt-e-ct_0.pdf)
- [2026 common procedure gross charges](https://www.healthvermont.gov/sites/default/files/document/hsi-stats-hrc-2026-cpt-p-oth_0.pdf)
- [Green Mountain Surgery Center price comparison](https://cms.jcloudpro.com/storage/clients/greenmountainsc_pro/file_1772548942526_19582.pdf)
- [CMS Hospital Price Transparency guidance](https://www.cms.gov/priorities/key-initiatives/hospital-price-transparency)

Most state-reported charges apply from October 1, 2025, through September 30, 2026. The source files were checked on August 5, 2026.

## Local development

The site has no runtime dependencies. Run `/opt/homebrew/bin/python3 -m http.server 4173` from the repository root, then open `http://localhost:4173`.

Run the data and syntax checks with `npm run check`.

## Scope

This prototype covers Vermont's 14 community hospitals and selected outpatient-center prices for five procedures. It does not include every clinician, independent imaging center, health plan rate, or patient-specific estimate.
