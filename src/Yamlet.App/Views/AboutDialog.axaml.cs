using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;

namespace Yamlet.App.Views;

/// <summary>Small "About Yamlet" dialog: version, platform info, and project links.</summary>
public partial class AboutDialog : Window
{
    private const string GitHubUrl = "https://github.com/piyushdoorwar/yamlet";
    private const string ReleasesUrl = "https://piyushdoorwar.github.io/yamlet/releases/";

    public AboutDialog()
    {
        AvaloniaXamlLoader.Load(this);

        SetField("VersionText", $"Version {GetAppVersion()}");
        SetField("OsText", GetOsName());
        SetField("ArchText", RuntimeInformation.OSArchitecture.ToString());
        SetField("RuntimeText", $".NET {Environment.Version}");
    }

    private void SetField(string name, string text)
    {
        if (this.FindControl<TextBlock>(name) is { } textBlock)
        {
            textBlock.Text = text;
        }
    }

    private static string GetAppVersion()
    {
        var informational = typeof(AboutDialog).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion;

        if (!string.IsNullOrWhiteSpace(informational))
        {
            return informational.Split('+')[0];
        }

        return typeof(AboutDialog).Assembly.GetName().Version?.ToString(3) ?? "0.0.0-dev";
    }

    private static string GetOsName()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return $"Windows {Environment.OSVersion.Version.Major}";
        }
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return $"macOS {Environment.OSVersion.Version.Major}";
        }
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            try
            {
                var pretty = File.ReadAllLines("/etc/os-release")
                    .FirstOrDefault(l => l.StartsWith("PRETTY_NAME=", StringComparison.Ordinal));
                if (pretty is not null)
                {
                    return pretty.Split('=', 2)[1].Trim('"');
                }
            }
            catch
            {
                // Fall through to the generic label.
            }
            return "Linux";
        }
        return RuntimeInformation.OSDescription;
    }

    private void GitHub_Click(object? sender, RoutedEventArgs e) => OpenUrl(GitHubUrl);
    private void Releases_Click(object? sender, RoutedEventArgs e) => OpenUrl(ReleasesUrl);

    private static void OpenUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            // Best-effort; ignore if no browser handler is available.
        }
    }
}
