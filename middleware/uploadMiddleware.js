const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Configured v2 instance — see config/cloudinary.js for why this is v2 and
// not the root `require('cloudinary')` object. multer-storage-cloudinary@4
// (the version pinned in package.json) calls
// `cloudinary.uploader.upload_stream(...)` on exactly what it is given here.
const cloudinary = require('../config/cloudinary');

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'rgms',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
  },
});

// 5MB cap on general-purpose uploads (profile photos, Student ID
// photos) — this had no limit at all before, so an oversized file would
// fail deep inside the Cloudinary upload with an opaque error instead
// of a clean, fast validation message.
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });


// ---------------------------------------------------------
// Medical document uploader
// ---------------------------------------------------------

const medicalDocumentStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'rgms/medical',
    allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
    resource_type: 'auto',
    type: 'authenticated',
  },
});

const MEDICAL_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
const MEDICAL_DOCUMENT_MAX_FILES = 10;

const medicalDocumentFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'application/pdf',
  ];

  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(
      new Error('Invalid file type. Please upload a JPG, PNG, or PDF.')
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