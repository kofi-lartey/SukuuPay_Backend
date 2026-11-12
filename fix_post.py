p = 'src/services/communityPost.service.js'
s = open(p).read()
old = '''  if (!["student", "teacher", "school_admin"].includes(authorRole)) {
    throw new ApiError("Only students, teachers, and school admins may create posts", 403);
  }'''
new = '''  if (!["student", "teacher", "school_admin", "super_admin"].includes(authorRole)) {
    throw new ApiError("Only students, teachers, school admins, and super admins may create posts", 403);
  }'''
assert old in s, 'old not found'
s = s.replace(old, new)
open(p, 'w').write(s)
print('done')