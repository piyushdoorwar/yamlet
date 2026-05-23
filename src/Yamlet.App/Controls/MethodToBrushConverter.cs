using System.Globalization;
using Avalonia.Data.Converters;
using Avalonia.Media;

namespace Yamlet.App.Controls;

/// <summary>Maps an HTTP method name to its badge color.</summary>
public sealed class MethodToBrushConverter : IValueConverter
{
    public static readonly MethodToBrushConverter Instance = new();

    private static readonly IBrush Get = Brush("#FF53B987");
    private static readonly IBrush Post = Brush("#FFE0B341");
    private static readonly IBrush Put = Brush("#FF5C9DED");
    private static readonly IBrush Patch = Brush("#FFA879E6");
    private static readonly IBrush Delete = Brush("#FFE5544B");
    private static readonly IBrush Other = Brush("#FF8A8A95");

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => (value as string)?.ToUpperInvariant() switch
        {
            "GET" => Get,
            "POST" => Post,
            "PUT" => Put,
            "PATCH" => Patch,
            "DELETE" => Delete,
            _ => Other,
        };

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();

    private static IBrush Brush(string hex) => new SolidColorBrush(Color.Parse(hex));
}
