import multer from "multer";
import type { Request, Response, NextFunction } from "express";

const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 5,
  },

  fileFilter: (_req: Request, file, callback) => {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      callback(
        new Error("Only JPEG, PNG, and WebP images are allowed."),
      );
      return;
    }

    callback(null, true);
  },
});

export const uploadMenuImages = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  upload.array("images", 5)(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? "Image size cannot exceed 5 MB."
          : error.code === "LIMIT_FILE_COUNT"
            ? "You can upload up to 5 images."
            : "Image upload failed.";

      res.status(400).json({
        success: false,
        message,
      });
      return;
    }

    if (error) {
      res.status(400).json({
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Invalid image upload.",
      });
      return;
    }

    next();
  });
};

// Profile settings still upload one image using the "image" field.
export const uploadMenuImage = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  upload.single("image")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? "Image size cannot exceed 5 MB."
          : "Image upload failed.";
      res.status(400).json({ success: false, message });
      return;
    }

    if (error) {
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "Invalid image upload.",
      });
      return;
    }

    next();
  });
};
