const multer = require('multer');
const cloudinaryStorage = require('multer-storage-cloudinary');
const CloudinaryStorage =
  cloudinaryStorage.CloudinaryStorage || cloudinaryStorage.default || cloudinaryStorage;
const cloudinary = require('../config/cloudinary');

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'rgms',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
  },
});

const upload = multer({ storage });

// --- Medical document uploader ---
// Separate from the default `upload` above on purpose: medical documents
// (certificates, clearances, doctor's notes) are sensitive, so this
// uploader stores them as Cloudinary `authenticated` resources instead of
// public `upload` resources. An authenticated resource's URL is useless
// without a signature, so even if a stored URL/public_id ever leaked it
// isn't directly viewable — actual access is only ever granted through
// userController.viewMedicalDocument, which checks the requester owns the
// file and mints a short-lived signed URL on demand.
//
// PDFs are included in allowed_formats alongside images because Cloudinary
// treats PDFs as an image-family resource (it can generate page thumbnails
// etc.), so resource_type: 'auto' handles both without a separate branch.
const medicalDocumentStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'rgms/medical',
    allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
    resource_type: 'auto',
    type: 'authenticated',
  },
});

const MEDICAL_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024; // 5MB, per file
// Cap on how many files can be selected in a single upload batch. Not a
// cap on how many a member can have on file in total (uploads are
// additive — see User.js's medicalDocuments comment) — just a sane
// per-request ceiling so one form submission can't multer-parse an
// unbounded number of multipart parts.
const MEDICAL_DOCUMENT_MAX_FILES = 10;

const medicalDocumentFileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
  if (!allowedMimeTypes.includes(file.mimetype)) {
    // Rejecting here (rather than letting Cloudinary reject it) lets the
    // error middleware surface a clean "Invalid file type" message instead
    // of a raw storage-provider error.
    return cb(new Error('Invalid file type. Please upload a JPG, PNG, or PDF.'));
  }
  cb(null, true);
};

const uploadMedicalDocument = multer({
  storage: medicalDocumentStorage,
  limits: { fileSize: MEDICAL_DOCUMENT_MAX_BYTES, files: MEDICAL_DOCUMENT_MAX_FILES },
  fileFilter: medicalDocumentFileFilter,
});

module.exports = upload;
module.exports.uploadMedicalDocument = uploadMedicalDocument;
module.exports.MEDICAL_DOCUMENT_MAX_BYTES = MEDICAL_DOCUMENT_MAX_BYTES;
module.exports.MEDICAL_DOCUMENT_MAX_FILES = MEDICAL_DOCUMENT_MAX_FILES;