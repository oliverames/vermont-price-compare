(function (root, factory) {
  const data = factory();
  root.VPC_DATA = data;
  if (typeof module !== "undefined" && module.exports) module.exports = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const providers = {
    bmh: { name: "Brattleboro Memorial Hospital", town: "Brattleboro", type: "hospital" },
    cvmc: { name: "Central Vermont Medical Center", town: "Berlin", type: "hospital" },
    copley: { name: "Copley Hospital", town: "Morrisville", type: "hospital" },
    uvmmc: { name: "University of Vermont Medical Center", town: "Burlington", type: "hospital" },
    gifford: { name: "Gifford Medical Center", town: "Randolph", type: "hospital" },
    grace: { name: "Grace Cottage Family Health & Hospital", town: "Townshend", type: "hospital" },
    mtAscutney: { name: "Mt. Ascutney Hospital", town: "Windsor", type: "hospital" },
    northCountry: { name: "North Country Hospital", town: "Newport", type: "hospital" },
    nvrh: { name: "Northeastern Vermont Regional Hospital", town: "St. Johnsbury", type: "hospital" },
    northwestern: { name: "Northwestern Medical Center", town: "St. Albans", type: "hospital" },
    porter: { name: "Porter Medical Center", town: "Middlebury", type: "hospital" },
    rutland: { name: "Rutland Regional Medical Center", town: "Rutland", type: "hospital" },
    svmc: { name: "Southwestern Vermont Medical Center", town: "Bennington", type: "hospital" },
    springfield: { name: "Springfield Hospital", town: "Springfield", type: "hospital" },
    gmsc: { name: "Green Mountain Surgery Center", town: "Colchester", type: "surgery-center" }
  };

  const sources = {
    colonoscopy: {
      label: "Vermont 2026 colonoscopy report",
      url: "https://www.healthvermont.gov/sites/default/files/document/hsi-stats-hrc-2026-cpt-j-diag_0.pdf"
    },
    mammogram: {
      label: "Vermont 2026 mammography report",
      url: "https://www.healthvermont.gov/sites/default/files/document/hsi-stats-hrc-2026-cpt-h-mam_0.pdf"
    },
    mri: {
      label: "Vermont 2026 MRI report",
      url: "https://www.healthvermont.gov/sites/default/files/document/hsi-stats-hrc-2026-cpt-f-mri_0.pdf"
    },
    ct: {
      label: "Vermont 2026 CT report",
      url: "https://www.healthvermont.gov/sites/default/files/document/hsi-stats-hrc-2026-cpt-e-ct_0.pdf"
    },
    surgery: {
      label: "Vermont 2026 common procedures report",
      url: "https://www.healthvermont.gov/sites/default/files/document/hsi-stats-hrc-2026-cpt-p-oth_0.pdf"
    },
    gmsc: {
      label: "Green Mountain Surgery Center price comparison",
      url: "https://cms.jcloudpro.com/storage/clients/greenmountainsc_pro/file_1772548942526_19582.pdf"
    },
    uvmmcCash: {
      label: "University of Vermont Medical Center standard charges",
      url: "https://www.uvmhealth.org/sites/default/files/030219309_university-of-vermont-medical-center-inc_standardcharges.csv",
      updated: "April 28, 2026"
    },
    cvmcCash: {
      label: "Central Vermont Medical Center standard charges",
      url: "https://www.uvmhealth.org/sites/default/files/222547186_central-vermont-medical-center-inc_standardcharges.csv",
      updated: "April 28, 2026"
    },
    porterCash: {
      label: "Porter Hospital standard charges",
      url: "https://www.uvmhealth.org/sites/default/files/030181058_porter-hospital-inc_standardcharges.csv",
      updated: "April 28, 2026"
    },
    northwesternCash: {
      label: "Northwestern Medical Center standard charges",
      url: "https://cdn.accureg.net/trans/northwesternmedical/03-0278425_Northwestern-Medical-Center_standardcharges.csv",
      updated: "August 5, 2026"
    }
  };

  const cash = (provider, amount, source) => ({ provider, amount, source });
  const gross = (provider, amount, extra) => Object.assign({ provider, amount }, extra || {});
  const missing = (provider, status, extra) => Object.assign({ provider, amount: null, status }, extra || {});

  const procedures = [
    {
      id: "colonoscopy",
      shortName: "Colonoscopy",
      name: "Screening colonoscopy without biopsy",
      code: "45378",
      aliases: ["colon exam", "colon cancer screening", "screening colonoscopy", "lower bowel scope"],
      grossSource: sources.colonoscopy,
      gross: [
        gross("bmh", 964), gross("cvmc", 4588), gross("copley", 1072), gross("uvmmc", 4747),
        gross("gifford", 730), missing("grace", "not-listed"), gross("mtAscutney", 3050),
        gross("northCountry", 10029), gross("nvrh", 7372), gross("northwestern", 802),
        gross("porter", 3739), gross("rutland", 6773), gross("svmc", 4642),
        missing("springfield", "incomplete", { partialAmount: 1926, partialBasis: "Physician charge only" })
      ],
      cash: [
        cash("uvmmc", 4293, sources.uvmmcCash), cash("cvmc", 3696.85, sources.cvmcCash),
        cash("porter", 3166, sources.porterCash), cash("northwestern", 1015.32, sources.northwesternCash)
      ],
      other: [{
        provider: "gmsc",
        amount: 1612,
        basis: "Facility gross charge",
        source: sources.gmsc,
        updated: "February 27, 2026",
        detail: "The center states that its bill covers the facility and necessary supplies. Surgeon, anesthesia, and pathology services can create separate bills."
      }]
    },
    {
      id: "mammogram",
      shortName: "Mammogram",
      name: "Screening mammography with computer-aided detection, bilateral",
      code: "77067",
      aliases: ["screening mammogram", "breast cancer screening", "bilateral mammogram"],
      grossSource: sources.mammogram,
      gross: [
        gross("bmh", 563),
        missing("cvmc", "incomplete", { partialAmount: 775, partialBasis: "Hospital charge only" }),
        gross("copley", 789), gross("uvmmc", 888), gross("gifford", 1103),
        missing("grace", "not-listed"), gross("mtAscutney", 797), gross("northCountry", 846),
        missing("nvrh", "incomplete", { partialAmount: 755, partialBasis: "Hospital charge only" }),
        gross("northwestern", 472), gross("porter", 841), gross("rutland", 602),
        gross("svmc", 908), gross("springfield", 653)
      ],
      cash: [
        cash("uvmmc", 777, sources.uvmmcCash), cash("cvmc", 774.63, sources.cvmcCash),
        cash("porter", 652, sources.porterCash), cash("northwestern", 222, sources.northwesternCash)
      ],
      other: []
    },
    {
      id: "mri-knee",
      shortName: "MRI of knee",
      name: "MRI of a lower-extremity joint without contrast",
      code: "73721",
      aliases: ["knee mri", "leg mri", "lower extremity mri", "joint mri"],
      grossSource: sources.mri,
      gross: [
        gross("bmh", 3458),
        missing("cvmc", "incomplete", { partialAmount: 3521, partialBasis: "Hospital charge only" }),
        gross("copley", 2924), gross("uvmmc", 4200), gross("gifford", 3486),
        missing("grace", "not-listed"), gross("mtAscutney", 5160), gross("northCountry", 4301),
        missing("nvrh", "incomplete", { partialAmount: 4339, partialBasis: "Hospital charge only" }),
        gross("northwestern", 6237), gross("porter", 3807), gross("rutland", 3932),
        gross("svmc", 4547), gross("springfield", 2354)
      ],
      cash: [
        cash("uvmmc", 5028, sources.uvmmcCash), cash("cvmc", 3520.8, sources.cvmcCash),
        cash("porter", 3470, sources.porterCash), cash("northwestern", 2665.76, sources.northwesternCash)
      ],
      other: []
    },
    {
      id: "ct-abdomen-pelvis",
      shortName: "CT scan",
      name: "CT scan of abdomen and pelvis with contrast",
      code: "74177",
      aliases: ["ct abdomen", "ct pelvis", "cat scan", "abdominal ct", "abdomen and pelvis ct"],
      grossSource: sources.ct,
      gross: [
        gross("bmh", 6043),
        missing("cvmc", "incomplete", { partialAmount: 5131, partialBasis: "Hospital charge only" }),
        gross("copley", 2810), gross("uvmmc", 5486), gross("gifford", 4167),
        gross("grace", 5289), gross("mtAscutney", 5438), gross("northCountry", 6823),
        missing("nvrh", "incomplete", { partialAmount: 110, partialBasis: "Hospital charge only" }),
        gross("northwestern", 4365), gross("porter", 3970), gross("rutland", 5014),
        gross("svmc", 5332), gross("springfield", 5262)
      ],
      cash: [
        cash("uvmmc", 6553, sources.uvmmcCash), cash("cvmc", 5130.56, sources.cvmcCash),
        cash("porter", 3519, sources.porterCash), cash("northwestern", 2051.36, sources.northwesternCash)
      ],
      other: []
    },
    {
      id: "carpal-tunnel",
      shortName: "Carpal tunnel release",
      name: "Carpal tunnel release surgery",
      code: "64721",
      aliases: ["carpal tunnel surgery", "wrist nerve release", "carpal release"],
      grossSource: sources.surgery,
      gross: [
        gross("bmh", 1028), gross("cvmc", 1776), gross("copley", 1882), gross("uvmmc", 1851),
        gross("gifford", 5033), missing("grace", "not-listed"), missing("mtAscutney", "not-listed"),
        gross("northCountry", 11813), gross("nvrh", 44401), gross("northwestern", 1083),
        missing("porter", "incomplete", { partialAmount: 1050, partialBasis: "Physician charge only" }),
        gross("rutland", 1992), gross("svmc", 8056),
        missing("springfield", "incomplete", { partialAmount: 1865, partialBasis: "Physician charge only" })
      ],
      cash: [],
      other: [{
        provider: "gmsc",
        amount: 2613.52,
        basis: "Facility gross charge",
        source: sources.gmsc,
        updated: "February 27, 2026",
        detail: "The center states that its bill covers the facility and necessary supplies. Surgeon, anesthesia, and pathology services can create separate bills."
      }]
    }
  ];

  return {
    providers,
    procedures,
    statePeriod: "October 1, 2025, through September 30, 2026",
    retrieved: "August 5, 2026"
  };
});
