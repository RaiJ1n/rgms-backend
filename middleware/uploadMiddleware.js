const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");

const cloudinary = require("../config/cloudinary");

// ---------------------------------------------------------
// General-purpose uploader
// ---------------------------------------------------------

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "rgms",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

// ---------------------------------------------------------
// Medical document uploader
// ---------------------------------------------------------

const medicalDocumentStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "rgms/medical",
    allowed_formats: ["jpg", "jpeg", "png", "pdf"],
    resource_type: "auto",
    type: "authenticated",
  },
});

const MEDICAL_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
const MEDICAL_DOCUMENT_MAX_FILES = 10;

const medicalDocumentFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "application/pdf",
  ];

  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(
      new Error("Invalid file type. Please upload a JPG, PNG, or PDF."),
    );
  }

  cb(null, true);
};

const uploadMedicalDocument = multer({
  storage: medicalDocumentStorage,
  limits: {
    fileSize: MEDICAL_DOCUMENT_MAX_BYTES,
    files: MEDICAL_DOCUMENT_MAX_FILES,
  },
  fileFilter: medicalDocumentFileFilter,
});

module.exports = upload;
module.exports.uploadMedicalDocument = uploadMedicalDocument;
module.exports.MEDICAL_DOCUMENT_MAX_BYTES = MEDICAL_DOCUMENT_MAX_BYTES;
module.exports.MEDICAL_DOCUMENT_MAX_FILES = MEDICAL_DOCUMENT_MAX_FILES;
