using System.Globalization;
using Avalonia.Data.Converters;
using Avalonia.Media;

namespace Yamlet.App.Controls;

/// <summary>Maps a response status category (set by the editor VM) to a color.</summary>
public sealed class StatusCategoryToBrushConverter : IValueConverter
{
    public static readonly StatusCategoryToBrushConverter Instance = new();

    private static readonly IBrush Success = Brush("#FF53B987");
    private static readonly IBrush Redirect = Brush("#FF5C9DED");
    private static readonly IBrush ClientError = Brush("#FFE0B341");
    private static readonly IBrush ServerError = Brush("#FFE5544B");
    private static readonly IBrush Neutral = Brush("#FF8A8A95");

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => (value as string) switch
        {
            "success" => Success,
            "redirect" => Redirect,
            "clienterror" => ClientError,
            "servererror" => ServerError,
            "error" => ServerError,
            _ => Neutral,
        };

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();

    private static IBrush Brush(string hex) => new SolidColorBrush(Color.Parse(hex));
}
