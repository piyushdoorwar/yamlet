using System.Text;

namespace Yamlet.App.Services;

/// <summary>
/// Produces Git-friendly file and directory names from user-entered names: lowercase,
/// hyphen-separated, ASCII-safe. Used to derive on-disk names for collections,
/// folders and request files.
/// </summary>
public static class PathNaming
{
    public static string Slugify(string name, string fallback = "untitled")
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return fallback;
        }

        var builder = new StringBuilder(name.Length);
        var lastWasHyphen = false;

        foreach (var ch in name.Trim().ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(ch) && ch < 128)
            {
                builder.Append(ch);
                lastWasHyphen = false;
            }
            else if (ch is ' ' or '-' or '_' or '.' or '/')
            {
                if (!lastWasHyphen && builder.Length > 0)
                {
                    builder.Append('-');
                    lastWasHyphen = true;
                }
            }
            // Any other character is dropped.
        }

        var slug = builder.ToString().Trim('-');
        return slug.Length == 0 ? fallback : slug;
    }

    /// <summary>
    /// Returns a path inside <paramref name="directory"/> for <paramref name="desiredFileName"/>
    /// that does not collide with an existing file, appending <c>-2</c>, <c>-3</c>, … as needed.
    /// </summary>
    public static string UniqueFilePath(string directory, string desiredFileName)
    {
        var name = Path.GetFileNameWithoutExtension(desiredFileName);
        var ext = Path.GetExtension(desiredFileName);
        var candidate = Path.Combine(directory, desiredFileName);

        var counter = 2;
        while (File.Exists(candidate))
        {
            candidate = Path.Combine(directory, $"{name}-{counter}{ext}");
            counter++;
        }

        return candidate;
    }

    /// <summary>As <see cref="UniqueFilePath"/> but for a sub-directory name.</summary>
    public static string UniqueDirectoryPath(string parent, string desiredName)
    {
        var candidate = Path.Combine(parent, desiredName);
        var counter = 2;
        while (Directory.Exists(candidate))
        {
            candidate = Path.Combine(parent, $"{desiredName}-{counter}");
            counter++;
        }

        return candidate;
    }
}
