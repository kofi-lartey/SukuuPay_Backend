import mongoose from "mongoose";

const resourceSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
    campusId: { type: mongoose.Schema.Types.ObjectId, ref: "Campus", default: null, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    assignedClasses: { type: [String], default: [] },
    assignedStudents: { type: [mongoose.Schema.Types.ObjectId], ref: "Student", default: [] },
  },
  { timestamps: true }
);

export const LmsResource = mongoose.model("LmsResource", resourceSchema);
export default LmsResource;